import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import websocket from "@fastify/websocket";
import {
  ConversationManager,
  ConversationExistsError,
} from "./conversation-manager.js";
import { registerRoutes } from "./router.js";
import { registerWsGateway } from "./ws-gateway.js";
import { registerSseGateway } from "./sse-gateway.js";
import { logger } from "../core/logger.js";

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
  manager: ConversationManager;
}

export async function startServer(opts: ServerOptions): Promise<FastifyInstance> {
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

  // WS 插件必须在声明路由之前 register。
  // errorHandler/升级失败日志走 fastify 默认实现即可(loggerInstance 已合流)。
  await fastify.register(websocket);

  // 先注册两个下行 gateway(各自自持连接映射),再把聚合计数传给 REST 路由。
  // connections 语义 = 「几个观察窗口在看」,业务侧不关心通道类型 —— 聚合在
  // 装配层完成,router 只认一个函数,零改动(S8)。
  const ws = registerWsGateway(fastify, opts.manager);
  const sse = registerSseGateway(fastify, opts.manager);
  registerRoutes(fastify, opts.manager, (id) => ws.getConnectionCount(id) + sse.getConnectionCount(id));

  await fastify.listen({ port: opts.port, host: "0.0.0.0" });
  log.info(
    {
      ws: `ws://localhost:${opts.port}/ws/{conversationId}`,
      sse: `http://localhost:${opts.port}/sse/{conversationId}`,
      rest: `http://localhost:${opts.port}/conversations/{create,list,delete}`,
    },
    "服务已启动"
  );
  return fastify;
}
