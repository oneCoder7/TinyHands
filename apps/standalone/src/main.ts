import "dotenv/config";
import { readStandaloneConfig } from "./config.js";
import { logger } from "./logger.js";
import { startServer } from "./server/server.js";
import { createTinyhandsHost } from "@tinyhands/server";

/**
 * 入口 / 组装根 —— tinyhands 是一个「多会话服务单元」,通过 REST + WebSocket
 * 被外部驱动。
 *
 * 一个进程内可并存 N 个 conversation(各自独立的事件流/runtime/工作目录),
 * 生命周期(创建/销毁)由上层业务侧经 REST 控制 —— 上层要多少会话是它的事,
 * 这里只提供 per-conversation 的能力。启动时 0 个会话,全等上游创建(或从磁盘懒恢复)。
 *
 * 【组装职责】main 是全项目唯一的组装根,只做进程级绑定:读 config →
 * 造进程级共享的 LLM 客户端 + ConversationStore → 把进程级依赖(llm/maxStep/runtime/store)
 * 注入会话装配工厂 → 把工厂交给 manager → 启动 server。单个组件的 new 都在
 * llm/factory 与 server/agent-session 里,main 不碰。环境变量也只在此显式解析一次。
 */
async function main() {
  const cfg = readStandaloneConfig();

  // Host 是 framework-neutral 组合根；CLI 只负责 env、transport 与进程生命周期。
  const host = await createTinyhandsHost({ ...cfg.host, logger });
  let server;
  try {
    server = await startServer({
      port: cfg.port,
      host,
    });
  } catch (err) {
    await host.close();
    throw err;
  }

  let shutdownPromise: Promise<void> | undefined;
  // 进程退出钩子属于 standalone CLI；Host 本身不碰 signal/process.exit。
  const gracefulShutdown = async (signal: string) => {
    if (shutdownPromise) return shutdownPromise;
    logger.info({ signal }, "收到退出信号,正在清理");
    shutdownPromise = (async () => {
      // Fastify.close 先停止接收新请求；Host.close 关闭事件订阅，使长连接可退出。
      const results = await Promise.allSettled([server.close(), host.close()]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "服务关闭失败");
      }
    })();
    return shutdownPromise;
  };
  const handleSignal = (signal: string) => {
    void gracefulShutdown(signal).then(
      () => process.exit(0),
      (err) => {
        logger.error({ err, signal }, "关闭失败");
        process.exit(1);
      }
    );
  };
  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
}

main().catch((err) => {
  // pino 惯例:err 字段走内置序列化(带 stack)
  logger.error({ err }, "启动失败");
  process.exit(1);
});
