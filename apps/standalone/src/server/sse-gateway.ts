import type { FastifyInstance } from "fastify";
import {
  type PublicStreamItem,
} from "@tinyhands/protocol";
import {
  ConversationNotFoundError,
  type ConversationService,
  type EventSubscription,
} from "@tinyhands/server";
import { logger } from "../logger.js";

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

/** 把 StreamItem 序列化成 SSE 帧。JSON.stringify 无裸换行,单行 data: 安全(S3)。 */
function toFrame(item: PublicStreamItem): string {
  const json = JSON.stringify(item);
  // S2:持久 Event 带 id(Last-Event-ID 锚点),Delta 瞬态不带
  return "delta" in item ? `data: ${json}\n\n` : `id: ${item.seq}\ndata: ${json}\n\n`;
}

export function registerSseGateway(
  fastify: FastifyInstance,
  manager: ConversationService
): void {
  let connSeq = 0;

  fastify.get<{ Params: { convId: string }; Querystring: { lastSeq?: string } }>(
    "/sse/:convId",
    // fastify 默认给每个 GET 自动注册复用同一 handler 的 HEAD 兄弟路由
    // (exposeHeadRoutes: true)。HEAD 走进本 handler 会 hijack + 订阅 + 心跳,
    // 但 Node 对 HEAD 响应抑制 body → 头永不 flush、end 永不调 → 客户端挂死 +
    // 服务端会残留幽灵订阅与心跳(对抗评审实测确认)。路由级关掉:
    // HEAD /sse/:convId → 404,干净 HTTP 语义拒绝(与 S5 同精神)。
    { exposeHeadRoute: false },
    async (req, reply) => {
      const convId = req.params.convId;

      // Last-Event-ID 优先，query 兜底；在 hijack 前解析并交给 Service 建立统一订阅。
      const rawHeader = req.headers["last-event-id"];
      const headerSeq = Number(Array.isArray(rawHeader) ? rawHeader[0] : rawHeader);
      const querySeq = Number(req.query.lastSeq);
      const lastSeq =
        Number.isFinite(headerSeq) && headerSeq > 0
          ? headerSeq
          : Number.isFinite(querySeq) && querySeq > 0
            ? querySeq
            : 0;

      // —— ① 先查会话再 hijack:此时还是正常 fastify 响应,404 走标准管线(S5)
      let subscription: EventSubscription;
      try {
        subscription = await manager.events(convId, { afterSeq: lastSeq });
      } catch (err) {
        if (!(err instanceof ConversationNotFoundError)) throw err;
        log.warn({ conversationId: convId }, "连接了不存在的会话");
        reply.code(404).send({ error: `conversation not found: ${convId}` });
        return;
      }
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
      let heartbeat: NodeJS.Timeout | undefined;
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        void subscription.close();
        if (heartbeat !== undefined) clearInterval(heartbeat);
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

        // —— ③ Service 已按锚点建立 backlog + live 的统一订阅。
        log.info({ conn: connId, conversationId: convId, lastSeq }, "连接建立");

        // 安全发送:销毁路径主动 end 后,订阅 handler 可能还有在途调用,
        // write-after-end 会抛 ERR_STREAM_WRITE_AFTER_END → 写前查 writableEnded。
        // (对端断开的 write 不抛错 —— 摸底实测 —— 此检查只为主动 end 路径)
        const write = (chunk: string) => {
          if (!res.writableEnded) res.write(chunk);
        };

        // —— ④ retry；EventSubscription 保证先 backlog、后 live。
        write(`retry: ${RETRY_MS}\n\n`);

        // —— ⑤ 心跳:注释帧,所有客户端天然忽略;穿透中间设施 idle 超时(S4)。
        //    每连接一个定时器 —— 学习项目量级,不做共享定时器的过早优化。
        heartbeat = setInterval(() => write(": hb\n\n"), HEARTBEAT_MS);

        // —— ⑥ 断开感知:仅移除订阅者/定时器,agent.run 照跑不误(零耦合)。
        //    'close' 对「客户端断开」与「服务端主动 end」都触发,清理统一走 cleanup。
        req.raw.on("close", cleanup);
        // 兜底:'close' 若在监听器注册前已 emit(见 cleanup 注释的通路 ②),
        // socket 此时已 destroyed —— 主动补一次清理,不依赖永不到来的回调
        if (req.raw.destroyed) cleanup();

        void (async () => {
          try {
            for await (const item of subscription) write(toFrame(item));
            if (subscription.closeReason === "conversation_deleted") {
              write(
                `data: ${JSON.stringify({ protocolError: "conversation destroyed" })}\n\n`
              );
            }
            if (!res.writableEnded) res.end();
          } catch (err) {
            log.warn(
              { err, conn: connId, conversationId: convId },
              "SSE 事件订阅异常，关闭连接"
            );
            if (!res.writableEnded) {
              res.write(
                `data: ${JSON.stringify({ protocolError: "event stream closed" })}\n\n`
              );
              res.end();
            }
          } finally {
            cleanup();
          }
        })();
      } catch (err) {
        log.error({ err, conn: connId, conversationId: convId }, "SSE 连接初始化异常");
        cleanup(); // 通路 ①:监听器未挂上,已获取的资源在此释放
        res.destroy(); // socket 已被接管,唯一能做的就是断掉,别让客户端挂死
      }
    }
  );
}
