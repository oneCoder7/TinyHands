import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import websocket from "@fastify/websocket";
import {
  ConversationExistsError,
  ConversationNotFoundError,
  InvalidConversationInputError,
  type TinyhandsHost,
} from "@tinyhands/server";
import { registerRoutes } from "./router.js";
import { registerWsGateway } from "./ws-gateway.js";
import { registerSseGateway } from "./sse-gateway.js";
import { logger } from "../logger.js";
import { createTinyhandsFetchHandler } from "@tinyhands/server/http";

const log = logger.child({ module: "server" });

/** REST body 上限:生命周期接口只有小 JSON,64KB 富余 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * server 装配 —— 基于 Fastify 的 HTTP + WS 服务。
 *
 * Fastify 的角色:REST 路由/解析/错误边界 + WS 升级路由(@fastify/websocket
 * 把 upgrade 塞进正常路由管线,hooks 对 WS 生效,未来鉴权 REST/WS 一处搞定)。
 *
 * 日志:把全局 pino 实例传给 fastify(loggerInstance),框架内部日志
 * (请求日志/404/WS 升级失败)与应用日志合流,且每请求自动带 reqId child。
 *
 * 与默认行为的两处刻意偏离:
 *  1. 覆盖 JSON parser:空 body 视为 {}(默认 400 FST_ERR_CTP_EMPTY_JSON_BODY,过严)
 *  2. listen 显式 0.0.0.0:fastify 默认只绑 localhost,容器/K8s 里探针会打不进来
 */
export interface ServerOptions {
  port: number;
  host: TinyhandsHost;
}

/** standalone 专属 Fastify 策略；嵌入方不会经过这里。 */
function createStandaloneFastify(): FastifyInstance {
  const fastify = Fastify({
    // pino Logger 结构上满足 FastifyBaseLogger;收窄类型让实例泛型保持默认,
    // 避免 Logger<...> 泛型渗透进 registerRoutes/registerWsGateway 的签名
    loggerInstance: logger as FastifyBaseLogger,
    bodyLimit: MAX_BODY_BYTES,
  });

  // 空 body → {};非法 JSON → 400(statusCode 标注后由 errorHandler 统一出格式)
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const text = typeof body === "string" ? body.trim() : "";
      if (!text) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    }
  );

  // 统一错误出口:业务错误按类型映射,其余透传 4xx / 兜底 500。
  // 对外错误体保持 {error: string} 简单格式(协议稳定,不随框架换格式)。
  fastify.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ConversationExistsError) {
      reply.code(409).send({ error: err.message });
      return;
    }
    if (err instanceof InvalidConversationInputError) {
      reply.code(400).send({ error: err.message });
      return;
    }
    if (err instanceof ConversationNotFoundError) {
      reply.code(404).send({ error: err.message });
      return;
    }
    const e = err as { statusCode?: number; message?: string };
    const status =
      typeof e.statusCode === "number" && e.statusCode < 500 ? e.statusCode : 500;
    if (status >= 500) {
      log.error({ err }, "请求处理异常");
      reply.code(500).send({ error: "internal error" });
      return;
    }
    reply.code(status).send({ error: e.message ?? "bad request" });
  });

  fastify.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: "not found" });
  });

  return fastify;
}

export async function startServer(opts: ServerOptions): Promise<FastifyInstance> {
  const fastify = createStandaloneFastify();
  await fastify.register(websocket);
  registerWsGateway(fastify, opts.host.conversations);
  registerSseGateway(fastify, opts.host.conversations);
  registerRoutes(fastify, opts.host.conversations);
  registerV1FetchBridge(fastify, createTinyhandsFetchHandler({ host: opts.host }));

  await fastify.listen({ port: opts.port, host: "0.0.0.0" });
  log.info(
    {
      ws: `ws://localhost:${opts.port}/ws/{conversationId}`,
      sse: `http://localhost:${opts.port}/sse/{conversationId}`,
      rest: `http://localhost:${opts.port}/conversations/{create,list,delete}`,
      v1: `http://localhost:${opts.port}/v1/conversations`,
    },
    "服务已启动"
  );
  return fastify;
}

/** standalone 内部 bridge；不是可导出的 Fastify 接入 API。 */
function registerV1FetchBridge(
  fastify: FastifyInstance,
  handle: (request: Request) => Promise<Response>
): void {
  fastify.route({
    method: ["GET", "POST", "DELETE"],
    url: "/v1/*",
    handler: async (request, reply) => {
      const abort = new AbortController();
      const body = serializeRequestBody(request.method, request.body);
      const headers = requestHeaders(request.headers);
      headers.delete("content-length");
      const fetchRequest = new Request(
        new URL(request.url, `http://${request.headers.host ?? "localhost"}`),
        {
          method: request.method,
          headers,
          body,
          signal: abort.signal,
        }
      );
      const response = await handle(fetchRequest);

      response.headers.forEach((value, key) => reply.header(key, value));
      if (response.body && response.headers.get("content-type")?.startsWith("text/event-stream")) {
        reply.hijack();
        reply.raw.writeHead(response.status, Object.fromEntries(response.headers));
        const reader = response.body.getReader();
        const onClose = () => {
          abort.abort();
          void reader.cancel();
        };
        reply.raw.once("close", onClose);
        try {
          while (!reply.raw.destroyed) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!reply.raw.write(value)) await waitForDrainOrClose(reply.raw);
          }
          if (!reply.raw.writableEnded) reply.raw.end();
        } finally {
          reply.raw.off("close", onClose);
          reader.releaseLock();
        }
        return;
      }

      reply.code(response.status);
      const bytes = response.body
        ? Buffer.from(await response.arrayBuffer())
        : Buffer.alloc(0);
      return reply.send(bytes);
    },
  });
}

function serializeRequestBody(
  method: string,
  body: unknown
): NonNullable<RequestInit["body"]> | undefined {
  if (method === "GET" || method === "HEAD" || body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string" || body instanceof Uint8Array) return body;
  return JSON.stringify(body);
}

function requestHeaders(
  source: Record<string, string | string[] | undefined>
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  return headers;
}

function waitForDrainOrClose(
  response: import("node:http").ServerResponse
): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      response.off("drain", done);
      response.off("close", done);
      resolve();
    };
    response.once("drain", done);
    response.once("close", done);
  });
}
