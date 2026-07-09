import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import { isDelta, type StreamItem, type EventHandler } from "../conversation/events.js";
import type { ConversationManager } from "./conversation-manager.js";
import { logger } from "../core/logger.js";

const log = logger.child({ module: "sse" });

/**
 * SSE gateway —— 第二条下行观察窗口:GET /sse/:convId。
 *
 * 与 WS gateway 语义对等:同样推 StreamItem(Event + Delta)、同样断线补发、同样
 * 与 run 生命周期零耦合 —— 两者都只是 EventStream 的订阅者。差异只在传输本性:
 *  - 会话不存在:HTTP 404(hijack 前) —— WS 是握手后 close 4404
 *  - 会话销毁:连接级私有帧 {protocolError} + end —— WS 是 close 4410
 *  - 断线补发锚点:SSE 协议内建(Event 帧带 id: → 浏览器重连自动回传 Last-Event-ID),
 *    ?lastSeq= 兜底 —— WS 只有 ?lastSeq= 手写重连
 *  - 心跳:SSE 中间设施链更长,idle 超时是真实威胁 → 注释帧保活
 *
 * 锚点机制:持久 Event 帧带 id: <seq>,Delta 帧不带 id —— EventSource 的 lastEventId
 * 只在收到带 id 的帧时更新,Delta 天然不产生补发锚点,与 WS 的 lastSeq 精确对齐。
 *
 * hijack 纪律:reply.hijack() 后 fastify 放手,handler 异常不进 setErrorHandler
 * (socket 悬空)→ 写流逻辑必须自 try/catch 兜底。
 */

/** 心跳间隔(具名常量,不进 config) */
const HEARTBEAT_MS = 15_000;
/** SSE 标准字段:建议客户端重连间隔(连接建立时发一次,做标准配齐) */
const RETRY_MS = 3000;

/** 一条 SSE 连接:原始响应流 + 它专属的心跳定时器 */
interface SseConn {
  res: ServerResponse;
  heartbeat: NodeJS.Timeout;
}

/** 把 StreamItem 序列化成 SSE 帧。JSON.stringify 无裸换行,单行 data: 安全(S3)。 */
function toFrame(item: StreamItem): string {
  const json = JSON.stringify(item);
  // S2:持久 Event 带 id(Last-Event-ID 锚点),Delta 瞬态不带
  return isDelta(item) ? `data: ${json}\n\n` : `id: ${item.seq}\ndata: ${json}\n\n`;
}

export function registerSseGateway(
  fastify: FastifyInstance,
  manager: ConversationManager
): { getConnectionCount: (id: string) => number } {
  // 「会话 → 连接」映射自持,同 ws-gateway 模式:manager 对传输层零依赖
  const connsByConv = new Map<string, Set<SseConn>>();
  let connSeq = 0;

  // 会话销毁:发连接级私有帧(S6,复用 WS 的 protocolError 概念 —— 不入事件流,
  // 只发给在连客户端;EventSource 经 onmessage 可编程感知)后结束响应。
  // 客户端若自动重连会撞 404,双保险闭环。
  manager.onDestroy((id) => {
    const set = connsByConv.get(id);
    if (!set) return;
    for (const conn of set) {
      clearInterval(conn.heartbeat);
      if (!conn.res.writableEnded) {
        conn.res.write(`data: ${JSON.stringify({ protocolError: "conversation destroyed" })}\n\n`);
        conn.res.end();
      }
    }
    // end 后连接的 close 事件仍会触发 cleanup(unsubscribe),此处只清连接表
    connsByConv.delete(id);
  });

  fastify.get<{ Params: { convId: string }; Querystring: { lastSeq?: string } }>(
    "/sse/:convId",
    // fastify 默认给每个 GET 自动注册复用同一 handler 的 HEAD 兄弟路由
    // (exposeHeadRoutes: true)。HEAD 走进本 handler 会 hijack + 订阅 + 心跳,
    // 但 Node 对 HEAD 响应抑制 body → 头永不 flush、end 永不调 → 客户端挂死 +
    // 服务端幽灵订阅污染 connections 计数(对抗评审实测确认)。路由级关掉:
    // HEAD /sse/:convId → 404,干净 HTTP 语义拒绝(与 S5 同精神)。
    { exposeHeadRoute: false },
    async (req, reply) => {
      const convId = req.params.convId;

      // —— ① 先查会话再 hijack:此时还是正常 fastify 响应,404 走标准管线(S5)
      // 异步懒恢复:getOrResume 会从磁盘 load 未加载的会话(纯读,不起 runtime)。
      const session = await manager.getOrResume(convId);
      if (!session) {
        log.warn({ conversationId: convId }, "连接了不存在的会话");
        reply.code(404).send({ error: `conversation not found: ${convId}` });
        return;
      }
      const { conversation } = session;
      const connId = ++connSeq;

      // —— ② hijack + SSE 响应头(官方指定的长流通道,@fastify/websocket 升级同款)
      reply.hijack();
      const res = reply.raw;

      // 资源句柄提到 try 外:逐步获取,cleanup 容忍任意部分初始化状态。
      // 清理不能只挂在 on('close') 上 —— 该监听器注册在资源获取之后,存在两条
      // 泄漏通路(对抗评审 lifecycle 维度确认):① 中途抛异常走 catch 时监听器
      // 还没挂上;② 未来路由管线加 async hook 后,客户端在 hook await 期间断开,
      // 'close' 在 handler 执行前就已 emit,迟注册的监听器永不回调(Node 对
      // IncomingMessage 不补发)。两条路都由具名 cleanup 兜底,幂等保证只清一次。
      let handler: EventHandler | undefined;
      let heartbeat: NodeJS.Timeout | undefined;
      let set: Set<SseConn> | undefined;
      let conn: SseConn | undefined;
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (handler) conversation.unsubscribe(handler);
        if (heartbeat !== undefined) clearInterval(heartbeat);
        if (set && conn) {
          set.delete(conn);
          // identity 检查防误删:会话销毁后同 id 重建时 map 里挂的已是新 Set,
          // 旧连接迟到的 cleanup 不得删掉新 Set(use-after-destroy)
          if (set.size === 0 && connsByConv.get(convId) === set) {
            connsByConv.delete(convId);
          }
        }
        log.info({ conn: connId, conversationId: convId }, "连接关闭,已移除订阅");
      };

      // hijack 后异常不再有 setErrorHandler 兜底,自 try/catch:失败即销毁 socket
      try {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          // no-transform:禁中间设施改写/压缩响应体(压缩会把流缓成块,帧不再实时)
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          // nginx 系反代关闭响应缓冲的约定头,非 nginx 环境无害(S4)
          "x-accel-buffering": "no",
        });

        // —— ③ 锚点解析:Last-Event-ID header 优先(浏览器重连自动带,是「最后
        //    真正收到的位置」,比 URL 里烙死的首连参数新),?lastSeq= 兜底;
        //    非法值按无锚点 → 全量(与 WS 首连一致)
        const rawHeader = req.headers["last-event-id"];
        const headerSeq = Number(Array.isArray(rawHeader) ? rawHeader[0] : rawHeader);
        const querySeq = Number(req.query.lastSeq);
        const lastSeq =
          Number.isFinite(headerSeq) && headerSeq > 0
            ? headerSeq
            : Number.isFinite(querySeq) && querySeq > 0
              ? querySeq
              : 0;
        log.info({ conn: connId, conversationId: convId, lastSeq }, "连接建立");

        // 安全发送:销毁路径主动 end 后,订阅 handler 可能还有在途调用,
        // write-after-end 会抛 ERR_STREAM_WRITE_AFTER_END → 写前查 writableEnded。
        // (对端断开的 write 不抛错 —— 摸底实测 —— 此检查只为主动 end 路径)
        const write = (chunk: string) => {
          if (!res.writableEnded) res.write(chunk);
        };

        // —— ④ retry → 补发历史 Event → 订阅实时流
        write(`retry: ${RETRY_MS}\n\n`);
        const backlog =
          lastSeq > 0 ? conversation.getEventsSince(lastSeq) : conversation.getEvents();
        for (const e of backlog) write(toFrame(e));
        if (backlog.length) {
          log.info({ conn: connId, count: backlog.length }, "补发历史事件");
        }
        handler = (item) => write(toFrame(item));
        conversation.subscribe(handler);

        // —— ⑤ 心跳:注释帧,所有客户端天然忽略;穿透中间设施 idle 超时(S4)。
        //    每连接一个定时器 —— 学习项目量级,不做共享定时器的过早优化。
        heartbeat = setInterval(() => write(": hb\n\n"), HEARTBEAT_MS);

        // 登记连接(该会话首个连接时惰性建 Set)
        set = connsByConv.get(convId);
        if (!set) {
          set = new Set();
          connsByConv.set(convId, set);
        }
        conn = { res, heartbeat };
        set.add(conn);

        // —— ⑥ 断开感知:仅移除订阅者/定时器/登记,agent.run 照跑不误(零耦合)。
        //    'close' 对「客户端断开」与「服务端主动 end」都触发,清理统一走 cleanup。
        req.raw.on("close", cleanup);
        // 兜底:'close' 若在监听器注册前已 emit(见 cleanup 注释的通路 ②),
        // socket 此时已 destroyed —— 主动补一次清理,不依赖永不到来的回调
        if (req.raw.destroyed) cleanup();
      } catch (err) {
        log.error({ err, conn: connId, conversationId: convId }, "SSE 连接初始化异常");
        cleanup(); // 通路 ①:监听器未挂上,已获取的资源在此释放
        res.destroy(); // socket 已被接管,唯一能做的就是断掉,别让客户端挂死
      }
    }
  );

  // REST 层用它组装 list 响应里的 connections;server.ts 与 WS 计数求和(S8)
  return { getConnectionCount: (id: string) => connsByConv.get(id)?.size ?? 0 };
}
