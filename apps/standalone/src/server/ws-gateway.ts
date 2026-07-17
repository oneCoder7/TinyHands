import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import type {
  PublicStreamItem,
} from "@tinyhands/protocol";
import {
  ConversationNotFoundError,
  type ConversationService,
  type EventSubscription,
} from "@tinyhands/server";
import { logger } from "../logger.js";

const log = logger.child({ module: "ws" });

/**
 * WS gateway —— 会话下行通道:/ws/:convId,按路径参数路由到对应会话。
 *
 * 纯下行:上行(发消息/打断)统一走 REST,本 gateway 只做观察窗口(订阅转发 +
 * 历史补发),收到任何上行消息一律回 protocolError 指引 REST。
 *
 * 连接归属:「会话 → 连接」映射(socketsByConv)由本 gateway 自持,manager 不认识
 * WebSocket;会话销毁时 Service 关闭对应 EventSubscription，本 gateway 根据
 * closeReason 映射为既有 4410 close code。
 *
 * agent 运行与「有没有订阅者」零耦合:连上 = 加订阅者,断开 = 移除,后台 run 照跑。
 * 断线重连:连接可带 ?lastSeq=N,先补 seq>N 的历史 Event 再转入实时(只补 Event 不
 * 补 Delta,Delta 瞬态不入库)。
 */

/** 上行已下线,统一指引到 REST */
const UPLINK_MOVED_HINT =
  "上行已迁移至 REST：发消息 POST /conversations/send，打断 POST /conversations/interrupt。WS 仅作下行观察窗口。";

/** WS close code:连接的 conversationId 不存在(4xxx 应用私有段,借 HTTP 404 助记) */
export const CLOSE_NOT_FOUND = 4404;
/** WS close code:会话被销毁(借 HTTP 410 助记) */
export const CLOSE_DESTROYED = 4410;

export function registerWsGateway(
  fastify: FastifyInstance,
  manager: ConversationService
): void {
  // 给每条连接一个自增编号,便于日志区分观察窗口
  let connSeq = 0;

  fastify.get<{ Params: { convId: string }; Querystring: { lastSeq?: string } }>(
    "/ws/:convId",
    { websocket: true },
    async (socket: WebSocket, req) => {
      // 路径参数已由路由器 percent-decode,不要再手动 decodeURIComponent(会双重解码)
      const convId = req.params.convId;

      const lastSeq = req.query.lastSeq ? Number(req.query.lastSeq) : 0;
      let subscription: EventSubscription;
      try {
        subscription = await manager.events(convId, {
          afterSeq: Number.isFinite(lastSeq) && lastSeq > 0 ? lastSeq : 0,
        });
      } catch (err) {
        if (!(err instanceof ConversationNotFoundError)) throw err;
        log.warn({ conversationId: convId }, "连接了不存在的会话");
        socket.close(CLOSE_NOT_FOUND, "conversation not found");
        return;
      }
      const connId = ++connSeq;

      log.info({ conn: connId, conversationId: convId, lastSeq }, "连接建立");

      // 安全发送:socket 可能已关,write 前查 readyState
      const send = (item: PublicStreamItem) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(item));
        }
      };
      // 协议级错误(只发给这条连接,不是会话事实,故不进 EventStream)
      const sendError = (message: string) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ protocolError: message }));
        }
      };

      // —— ①/② Service 统一提供 backlog + live，不向 gateway 暴露 Conversation。
      void (async () => {
        try {
          for await (const item of subscription) send(item);
          if (
            subscription.closeReason === "conversation_deleted" &&
            socket.readyState === WebSocket.OPEN
          ) {
            socket.close(CLOSE_DESTROYED, "conversation destroyed");
          }
        } catch (err) {
          log.warn(
            { err, conn: connId, conversationId: convId },
            "WS 事件订阅异常，关闭连接"
          );
          socket.close(1011, "event stream closed");
        }
      })();

      // —— ③ 上行:已下线(命令面统一 REST)。不静默忽略,明确回指引 —— 否则
      //    仍按旧协议发消息的客户端「没反应」无从排查。
      socket.on("message", (raw) => {
        log.warn(
          { conn: connId, conversationId: convId, raw: raw.toString().slice(0, 80) },
          "收到上行消息(WS 上行已下线),回 REST 指引"
        );
        sendError(UPLINK_MOVED_HINT);
      });

      // —— ④ 断开:仅移除订阅者,agent.run 不受影响
      const cleanup = () => {
        void subscription.close();
        log.info({ conn: connId, conversationId: convId }, "连接关闭,已移除订阅");
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    }
  );
}
