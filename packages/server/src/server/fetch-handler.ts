import {
  ConversationRecordExistsError,
  ConversationRecoveryError,
} from "../conversation/conversation-store.js";
import {
  type StreamClosedControl,
  type TinyhandsAction,
  type TinyhandsErrorBody,
  type TinyhandsErrorCode,
  type PublicStreamItem,
} from "@tinyhands/protocol";
import type { TinyhandsHost } from "./tinyhands-host.js";
import {
  ConversationExistsError,
  ConversationNotFoundError,
  ConversationServiceClosedError,
  ConversationServiceClosingError,
  EventStreamOverflowError,
  InvalidConversationInputError,
  type EventSubscription,
} from "./conversation-service.js";

const MAX_BODY_BYTES = 64 * 1024;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export interface CreateTinyhandsFetchHandlerOptions {
  host: TinyhandsHost;
  basePath?: string;
  authorize?: (
    request: Request,
    action: TinyhandsAction,
    conversationId?: string
  ) => void | Response | Promise<void | Response>;
}

/** 标准 WHATWG Request/Response 入口，不依赖任何 Node Web framework 类型。 */
export function createTinyhandsFetchHandler(
  options: CreateTinyhandsFetchHandlerOptions
): (request: Request) => Promise<Response> {
  const root = `${normalizeBasePath(options.basePath)}/v1`;

  return async (request) => {
    try {
      const url = new URL(request.url);
      const path = matchPath(url.pathname, root);
      if (!path) return protocolError(404, "invalid_argument", "route not found");

      if (path.length === 1 && path[0] === "conversations") {
        if (request.method === "POST") {
          const denied = await options.authorize?.(request, "conversation:create");
          if (denied instanceof Response) return denied;
          const body = await readJsonBody(request);
          const input = parseCreateInput(body);
          const created = await options.host.conversations.create(input);
          return jsonResponse(created, 201);
        }
        if (request.method === "GET") {
          const denied = await options.authorize?.(request, "conversation:list");
          if (denied instanceof Response) return denied;
          const conversations = (await options.host.conversations.list()).map(
            ({ conversationId, createdAt, running }) => ({
              conversationId,
              createdAt,
              running,
            })
          );
          return jsonResponse({ conversations });
        }
        return methodNotAllowed();
      }

      if (path.length < 2 || path[0] !== "conversations") {
        return protocolError(404, "invalid_argument", "route not found");
      }
      const conversationId = decodePathSegment(path[1]!);

      if (path.length === 2) {
        if (request.method !== "DELETE") return methodNotAllowed();
        const denied = await options.authorize?.(
          request,
          "conversation:delete",
          conversationId
        );
        if (denied instanceof Response) return denied;
        return jsonResponse(
          await options.host.conversations.delete(conversationId)
        );
      }

      if (path.length === 3 && path[2] === "messages") {
        if (request.method !== "POST") return methodNotAllowed();
        const denied = await options.authorize?.(
          request,
          "conversation:send",
          conversationId
        );
        if (denied instanceof Response) return denied;
        const body = await readJsonBody(request);
        if (!isRecord(body) || typeof body.text !== "string" || body.text.length === 0) {
          throw new InvalidConversationInputError("消息 text 必须是非空字符串");
        }
        return jsonResponse(
          await options.host.conversations.send(conversationId, body.text)
        );
      }

      if (path.length === 3 && path[2] === "interrupt") {
        if (request.method !== "POST") return methodNotAllowed();
        const denied = await options.authorize?.(
          request,
          "conversation:interrupt",
          conversationId
        );
        if (denied instanceof Response) return denied;
        return jsonResponse(
          await options.host.conversations.interrupt(conversationId)
        );
      }

      if (path.length === 3 && path[2] === "events") {
        if (request.method !== "GET") return methodNotAllowed();
        const denied = await options.authorize?.(
          request,
          "conversation:read",
          conversationId
        );
        if (denied instanceof Response) return denied;
        const afterSeq = parseAfterSeq(request, url);
        const subscription = await options.host.conversations.events(conversationId, {
          afterSeq,
          signal: request.signal,
        });
        return eventStreamResponse(subscription);
      }

      return protocolError(404, "invalid_argument", "route not found");
    } catch (error) {
      return mapError(error);
    }
  };
}

function eventStreamResponse(subscription: EventSubscription): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("retry: 3000\n\n"));
      void (async () => {
        let streamErrored = false;
        try {
          for await (const item of subscription) {
            if (cancelled) break;
            controller.enqueue(encoder.encode(toSseFrame(item)));
          }
          if (!cancelled) {
            const control = controlForCloseReason(subscription.closeReason);
            if (control) controller.enqueue(encoder.encode(toControlFrame(control)));
          }
        } catch (error) {
          if (!cancelled) {
            if (error instanceof EventStreamOverflowError) {
              const control: StreamClosedControl = {
                type: "stream_closed",
                code: "event_stream_overflow",
                message: error.message,
              };
              controller.enqueue(encoder.encode(toControlFrame(control)));
            } else {
              streamErrored = true;
              controller.error(error);
            }
          }
        } finally {
          if (!cancelled && !streamErrored) controller.close();
        }
      })();
    },
    async cancel() {
      cancelled = true;
      await subscription.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function toSseFrame(item: PublicStreamItem): string {
  const data = `data: ${JSON.stringify(item)}\n\n`;
  return "delta" in item ? data : `id: ${item.seq}\n${data}`;
}

function toControlFrame(control: StreamClosedControl): string {
  return `event: tinyhands.control\ndata: ${JSON.stringify(control)}\n\n`;
}

function controlForCloseReason(
  reason: EventSubscription["closeReason"]
): StreamClosedControl | undefined {
  if (!reason || reason === "observer_closed") return undefined;
  return {
    type: "stream_closed",
    code: reason,
    message:
      reason === "conversation_deleted"
        ? "conversation 已删除"
        : reason === "event_stream_overflow"
          ? "事件消费者积压过多"
          : reason === "host_closing"
            ? "Tinyhands Host 正在关闭"
            : "Tinyhands Host 已关闭",
  };
}

function parseAfterSeq(request: Request, url: URL): number {
  const header = request.headers.get("last-event-id");
  const raw = header && header.trim() !== "" ? header : url.searchParams.get("afterSeq");
  if (raw === null) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidConversationInputError("afterSeq 必须是非负整数");
  }
  return value;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new InvalidConversationInputError("请求体超过 64KB");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new InvalidConversationInputError("请求体超过 64KB");
  }
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidConversationInputError("请求体不是合法 JSON");
  }
}

function parseCreateInput(value: unknown): {
  conversationId?: string;
  tools?: string[];
} {
  if (!isRecord(value)) {
    throw new InvalidConversationInputError("请求体必须是 JSON object");
  }
  const { conversationId, tools } = value;
  if (conversationId !== undefined && typeof conversationId !== "string") {
    throw new InvalidConversationInputError("conversationId 必须是字符串");
  }
  if (
    tools !== undefined &&
    (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string"))
  ) {
    throw new InvalidConversationInputError("tools 必须是字符串数组");
  }
  return {
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(tools !== undefined ? { tools: tools as string[] } : {}),
  };
}

function mapError(error: unknown): Response {
  if (error instanceof InvalidConversationInputError) {
    return protocolError(400, "invalid_argument", error.message);
  }
  if (
    error instanceof ConversationExistsError ||
    error instanceof ConversationRecordExistsError
  ) {
    return protocolError(409, "conversation_exists", error.message);
  }
  if (error instanceof ConversationNotFoundError) {
    return protocolError(404, "conversation_not_found", error.message);
  }
  if (error instanceof ConversationServiceClosingError) {
    return protocolError(503, "host_closing", error.message);
  }
  if (error instanceof ConversationServiceClosedError) {
    return protocolError(503, "host_closed", error.message);
  }
  if (error instanceof ConversationRecoveryError) {
    return protocolError(500, "conversation_recovery_failed", error.message);
  }
  return protocolError(500, "internal_error", "internal error");
}

function protocolError(
  status: number,
  code: TinyhandsErrorCode,
  message: string
): Response {
  const body: TinyhandsErrorBody = { error: { code, message } };
  return jsonResponse(body, status);
}

function methodNotAllowed(): Response {
  return protocolError(405, "invalid_argument", "method not allowed");
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: JSON_HEADERS,
  });
}

function normalizeBasePath(value: string | undefined): string {
  if (!value || value === "/") return "";
  const withSlash = value.startsWith("/") ? value : `/${value}`;
  return withSlash.replace(/\/+$/, "");
}

function matchPath(pathname: string, root: string): string[] | undefined {
  if (pathname === root) return [];
  if (!pathname.startsWith(`${root}/`)) return undefined;
  return pathname.slice(root.length + 1).split("/");
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new InvalidConversationInputError("conversationId URL 编码非法");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
