import type { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import type { StreamItem, EventHandler } from "../conversation/events.js";
import type { ConversationManager } from "./conversation-manager.js";
import { logger } from "../core/logger.js";

const log = logger.child({ module: "ws" });

/**
 * WS gateway —— 会话下行通道:/ws/:convId,按路径参数路由到对应会话。
 *
 * 纯下行:上行(发消息/打断)统一走 REST,本 gateway 只做观察窗口(订阅转发 +
 * 历史补发),收到任何上行消息一律回 protocolError 指引 REST。
 *
 * 连接归属:「会话 → 连接」映射(socketsByConv)由本 gateway 自持,manager 不认识
 * WebSocket;会话销毁时 manager 经 onDestroy 回调本 gateway 关连接,connections
 * 计数也经 getConnectionCount 对外提供。
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
  manager: ConversationManager
): { getConnectionCount: (id: string) => number } {
  // 「会话 → 连接」映射归 gateway 自持。manager 对传输层零依赖。
  const socketsByConv = new Map<string, Set<WebSocket>>();
  // 给每条连接一个自增编号,便于日志区分观察窗口
  let connSeq = 0;

  // 会话销毁时,manager 回调本 gateway 关掉该会话全部连接(替代原 manager 亲手 close)
  manager.onDestroy((id) => {
    const set = socketsByConv.get(id);
    if (!set) return;
    for (const ws of set) {
      ws.close(CLOSE_DESTROYED, "conversation destroyed");
    }
    socketsByConv.delete(id);
  });

  fastify.get<{ Params: { convId: string }; Querystring: { lastSeq?: string } }>(
    "/ws/:convId",
    { websocket: true },
    async (socket: WebSocket, req) => {
      // 路径参数已由路由器 percent-decode,不要再手动 decodeURIComponent(会双重解码)
      const convId = req.params.convId;

      // 会话不存在:握手已完成,用应用级 close code 告知(可排查)
      // 异步懒恢复:未加载的会话从磁盘 load(纯读,不起 runtime)。
      const session = await manager.getOrResume(convId);
      if (!session) {
        log.warn({ conversationId: convId }, "连接了不存在的会话");
        socket.close(CLOSE_NOT_FOUND, "conversation not found");
        return;
      }
      // await 期间客户端可能已断开:后续 send() 内部会查 readyState,这里不提前 return,
      // 让 cleanup 路径统一处理(补发/订阅都会因 readyState 检查而 no-op)。
      const { conversation } = session;
      const connId = ++connSeq;

      // 登记连接到本 gateway 的映射(该会话首个连接时惰性建 Set)
      let set = socketsByConv.get(convId);
      if (!set) {
        set = new Set();
        socketsByConv.set(convId, set);
      }
      set.add(socket);

      // —— 解析 lastSeq(重连补发用)
      const lastSeq = req.query.lastSeq ? Number(req.query.lastSeq) : 0;
      log.info({ conn: connId, conversationId: convId, lastSeq }, "连接建立");

      // 安全发送:socket 可能已关,write 前查 readyState
      const send = (item: StreamItem) => {
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

      // —— ① 补发历史 Event
      const backlog =
        lastSeq > 0
          ? conversation.getEventsSince(lastSeq)
          : conversation.getEvents(); // 首连:推全部历史,让新观察者看到全貌
      for (const e of backlog) send(e);
      if (backlog.length) {
        log.info({ conn: connId, count: backlog.length }, "补发历史事件");
      }

      // —— ② 订阅实时流(Event + Delta)。这条 handler 就是这条连接的观察窗口。
      const handler: EventHandler = (item) => send(item);
      conversation.subscribe(handler);

      // —— ③ 上行:已下线(命令面统一 REST)。不静默忽略,明确回指引 —— 否则
      //    仍按旧协议发消息的客户端「没反应」无从排查。
      socket.on("message", (raw) => {
        log.warn(
          { conn: connId, conversationId: convId, raw: raw.toString().slice(0, 80) },
          "收到上行消息(WS 上行已下线),回 REST 指引"
        );
        sendError(UPLINK_MOVED_HINT);
      });

      // —— ④ 断开:仅移除订阅者与连接登记,agent.run 不受影响
      const cleanup = () => {
        conversation.unsubscribe(handler);
        set.delete(socket);
        // 空 Set 不留,避免残留;identity 检查防误删 —— 若会话已销毁并用同 id 重建,
        // map 里挂的已是新 Set,旧连接迟到的 cleanup 不得删掉新 Set(use-after-destroy)。
        if (set.size === 0 && socketsByConv.get(convId) === set) {
          socketsByConv.delete(convId);
        }
        log.info({ conn: connId, conversationId: convId }, "连接关闭,已移除订阅");
      };
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    }
  );

  // REST 层用它组装 list 响应里的 connections(manager 不认识连接)
  return { getConnectionCount: (id: string) => socketsByConv.get(id)?.size ?? 0 };
}
