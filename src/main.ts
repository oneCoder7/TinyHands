import "dotenv/config";
import { getConfig } from "./core/config.js";
import { logger } from "./core/logger.js";
import { createLLMClient } from "./llm/factory.js";
import { makeAgentSessionFactory } from "./server/agent-session.js";
import { ConversationManager } from "./server/conversation-manager.js";
import { startServer } from "./server/server.js";
import { cleanupOrphanContainers } from "./runtime/docker-runtime.js";

/**
 * 入口 / 组装根 —— tinyhands 是一个「多会话服务单元」,通过 REST + WebSocket
 * 被外部驱动。
 *
 * 一个进程内可并存 N 个 conversation(各自独立的事件流/runtime/工作目录),
 * 生命周期(创建/销毁)由上层业务侧经 REST 控制 —— 上层要多少会话是它的事,
 * 这里只提供 per-conversation 的能力。启动时 0 个会话,全等上游创建。
 *
 * 【组装职责】main 是全项目唯一的组装根,只做进程级绑定:读 config →
 * 造进程级共享的 LLM 客户端 → 把进程级依赖(llm/maxStep/runtime)注入会话装配工厂 →
 * 把工厂交给 manager → 启动 server。单个组件的 new 都在 llm/factory 与
 * server/agent-session 里,main 不碰。getConfig() 也只在此调用一次。
 */
async function main() {
  const cfg = getConfig();

  // 启动时清理上次非正常退出遗留的 sandbox 容器(保底;runtime=local 时快速 no-op)
  await cleanupOrphanContainers();

  // LLM 客户端无会话状态,全进程共享一个(provider 接缝在 llm/factory)
  const llm = createLLMClient(cfg.llm);

  // 进程级依赖注入一次,得到「拿数据造会话」的工厂;会话级数据(id/workspaceDir)
  // 在请求到达时由 manager 作参数传入
  const createSession = makeAgentSessionFactory({
    llm,
    maxStep: cfg.maxStep,
    runtime: cfg.runtime,
    docker: cfg.docker,
    opensandbox: cfg.opensandbox,
  });

  const manager = new ConversationManager({
    workspaceRoot: cfg.workspaceRoot,
    createSession,
  });

  await startServer({ port: cfg.port, manager });

  // 进程退出钩子:尽力清理 sandbox 容器(SIGINT/SIGTERM,无法覆盖 kill -9)
  const gracefulShutdown = async (signal: string) => {
    logger.info({ signal }, "收到退出信号,正在清理");
    await cleanupOrphanContainers();
    process.exit(0);
  };
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
}

main().catch((err) => {
  // pino 惯例:err 字段走内置序列化(带 stack)
  logger.error({ err }, "启动失败");
  process.exit(1);
});
