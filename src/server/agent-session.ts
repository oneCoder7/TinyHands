import type { LLMClient } from "../llm/llm-client.js";
import { Conversation } from "../conversation/conversation.js";
import type { Event } from "../conversation/events.js";
import { findUnmatchedToolCalls } from "../conversation/events.js";
import type { EventStore, ConversationMeta } from "../conversation/event-store.js";
import { Agent } from "../agent/agent.js";
import { LocalRuntime } from "../runtime/local-runtime.js";
import { DockerRuntime } from "../runtime/docker-runtime.js";
import { OpenSandboxRuntime } from "../runtime/opensandbox-runtime.js";
import { ToolRegistry } from "../tools/tool.js";
import { readFileTool } from "../tools/read-file.js";
import { writeFileTool } from "../tools/write-file.js";
import { finishTool } from "../tools/finish.js";
import { optionalToolCatalog } from "../tools/catalog.js";
import { logger } from "../core/logger.js";

const log = logger.child({ module: "agent-session" });

/**
 * AgentSession —— 一个会话的集束层:运行时组件 + 运行期簿记捆成一个具名结构。
 *
 * 住 server/ 而非 conversation/:它同时引用 Conversation 与 Agent,放 conversation/
 * 会与 agent → conversation 的单向依赖形成目录级循环;且 running/createdAt 是
 * 「会话在服务端运行」才有的簿记,本质是两个内核之上的管理层。
 *
 * Conversation 与 Agent 分离:状态(事件历史+runtime)与行为(prompt/工具/循环控制)
 * 解耦,换/多 agent 时状态不动。成对持有的代价由这个集束层吸收。
 */
export interface AgentSession {
  readonly conversationId: string;
  /** 状态内核:事件流 + runtime。 */
  readonly conversation: Conversation;
  /** 行为内核:无状态驱动器,agent.run(conversation) 驱动上面那份状态。 */
  readonly agent: Agent;
  readonly workspaceDir: string;
  readonly createdAt: number;
  /** 同一会话一次只允许一个 agent.run(去重标志)。 */
  running: boolean;
  /**
   * 当前 run 的中止句柄;无 run 在跑时为 null。
   * per-run 一次性:driveRun 每轮换新 controller(AbortSignal 不可复位)。
   */
  runAbort: AbortController | null;
  /**
   * 执行环境是否已 create。runtime 惰性化:建会话/读历史都不起 runtime,
   * 首次真正运行(driveRun)时才 create,幂等保证只 create 一次。见 ensureRuntimeReady。
   */
  runtimeStarted: boolean;
}

/**
 * 装配端口 —— manager 通过它「拿数据造会话」,自己从不 new 组件。
 * 每会话数据(conversationId/workspaceDir)作参数流动;进程级依赖(llm/maxStep)
 * 由下面工厂闭包捕获,不穿透 manager。
 *
 * initialEvents:恢复(resume)场景由 manager 从 EventStore load 后传入,灌进 EventStream
 * 续接历史;新建会话不传。工厂返回 Promise 仅因内部有异步装配余地,不再在此 create runtime
 * (runtime 已惰性化,首次运行才起)。
 */
export type SessionFactory = (opts: {
  conversationId: string;
  workspaceDir: string;
  /** 要启用的可选工具列表(默认 ["run_bash"],向后兼容) */
  tools?: string[];
  /** 恢复场景:已从磁盘 load 的历史事件,灌入 EventStream 续接。新建不传。 */
  initialEvents?: Event[];
  /** 恢复场景:已从磁盘 load 的元信息(含 createdAt/tools)。新建不传。 */
  initialMeta?: ConversationMeta;
}) => Promise<AgentSession>;

/**
 * 生产侧工厂 —— 进程级依赖注入一次,返回一个 SessionFactory。
 * 全项目唯一串起内核 + runtime + 工具具体实现的地方。runtime 按 config.runtime 选择。
 */
export function makeAgentSessionFactory(deps: {
  llm: LLMClient;
  maxStep: number;
  runtime: "local" | "docker" | "opensandbox";
  docker: { image: string };
  opensandbox: { serverUrl: string; apiKey?: string; image: string };
  /** 事件持久化:落盘 + 恢复。注入给每个会话的 Conversation。 */
  eventStore: EventStore;
}): SessionFactory {
  return async ({ conversationId, workspaceDir, tools: toolNames, initialEvents, initialMeta }) => {
    // ① 组装 ToolRegistry:必选 3 个 + 可选工具。
    //   优先级:调用方传入(新建) > initialMeta.tools(恢复) > 默认 ["run_bash"]
    const enabledTools = toolNames ?? initialMeta?.tools ?? ["run_bash"];
    const registry = new ToolRegistry()
      .register(readFileTool)
      .register(writeFileTool)
      .register(finishTool);

    for (const name of enabledTools) {
      const tool = optionalToolCatalog.get(name);
      if (!tool) {
        throw new Error(
          `未知的可选工具："${name}"。可用工具:${[...optionalToolCatalog.keys()].join(", ")}`
        );
      }
      registry.register(tool);
    }

    const agent = new Agent(deps.llm, registry, { maxStep: deps.maxStep });

    // ② 按配置选择执行环境——这里是唯一的 runtime 分叉点。
    //    注意:此处只 new 对象(构造无副作用),不 create()。runtime 惰性化 ——
    //    首次 driveRun 经 ensureRuntimeReady 才真正起环境(建容器/连沙箱)。
    //    故「建会话记录」「读历史/恢复」都不烧容器。
    const runtime = (() => {
      switch (deps.runtime) {
        case "docker":
          return new DockerRuntime({
            image: deps.docker.image,
            conversationId,
          });
        case "opensandbox":
          return new OpenSandboxRuntime({
            serverUrl: deps.opensandbox.serverUrl,
            apiKey: deps.opensandbox.apiKey,
            image: deps.opensandbox.image,
          });
        default:
          return new LocalRuntime({ cwd: workspaceDir });
      }
    })();

    // Conversation 接 EventStore:emit 落盘;initialEvents 灌入恢复历史。
    const conversation = new Conversation(conversationId, runtime, {
      store: deps.eventStore,
      initialEvents,
    });
    return {
      conversationId,
      conversation,
      agent,
      workspaceDir,
      // 恢复时用原创建时间;新建用当前时间。
      createdAt: initialMeta?.createdAt ?? Date.now(),
      running: false,
      runAbort: null,
      runtimeStarted: false,
    };
  };
}

/**
 * 确保执行环境就绪 —— runtime 惰性化的落点。幂等:只在首次真正运行时 create,
 * 之后 no-op。把「起重型执行环境」绑定到「第一次真正运行」而非「建会话记录」,
 * 让建会话/读历史/恢复都零 runtime 副作用。
 */
async function ensureRuntimeReady(session: AgentSession): Promise<void> {
  if (session.runtimeStarted) return;
  await session.conversation.runtime.create();
  session.runtimeStarted = true;
}

/**
 * 提交一条用户消息并驱动会话推进(现由 REST 调用)。
 *  1. 把 user_message 沉进事件流(真相源),广播给所有订阅者
 *  2. 触发后台 driveRun —— 不 await。并发保护是会话级的:running 挂在 session 上,
 *     同一会话一次一个 run,不同会话可并行。
 *
 * async:emit 需 await 落盘(先落盘后广播)。落盘失败向 REST 调用方传播 → 返回 500,
 * 客户端明确得知消息未被受理(而非静默丢失)。
 */
export async function submitUserMessage(session: AgentSession, text: string): Promise<void> {
  // ① 用户消息入事件流(await 落盘成功后才广播给所有订阅者)
  await session.conversation.emit({ type: "user_message", source: "user", text });

  // ② 已有 run 在跑:消息已入流,不重复触发。它若落在当前 run 最后一次投影之后,
  //    run 结束时 driveRun 会按水位线发现并立即重跑(lost-wakeup 的正解)。
  if (session.running) {
    log.info(
      { conversationId: session.conversationId },
      "已有 run 在跑,新消息已入事件流,本次不重复触发"
    );
    return;
  }

  // ③ 后台驱动(fire-and-forget;异常已在 driveRun 内兜底,不会成为未处理 rejection)
  void driveRun(session);
}

/**
 * 打断进行中的 run —— 协作式:先留痕(interrupted 事件),再拉闸(abort LLM 请求)。
 * run 在检查点上识别 signal.aborted 并以 status:"interrupted" 正常返回,
 * 不 emit error(打断是用户动作不是错误)。进行中的工具不杀,等其自然结束。
 *
 * async:interrupted 事件需 await 落盘。
 *
 * @returns true=已发出打断;false=幂等 no-op(空闲没有 run,或已在打断中)
 */
export async function interruptRun(session: AgentSession): Promise<boolean> {
  if (!session.running || !session.runAbort) return false; // 空闲:无事可断
  if (session.runAbort.signal.aborted) return false; // 已在打断中:去重
  // 先留痕再拉闸:interrupted 先入流,订阅者先看到「用户打断了」,
  // 随后才是检查点③可能补的 isError tool_result。
  await session.conversation.emit({ type: "interrupted", source: "user" });
  session.runAbort.abort();
  return true;
}

/**
 * 驱动循环 —— 一次「用户可感知的推进」可能包含多个 agent.run:
 * run 以 completed 结束后,若投影水位线之后还躺着本次 run 从未见过的 user_message
 * (消息恰落在最后一次投影与 run 结束之间的窗口),立即重跑,唤醒信号不丢。
 *
 * 不重跑的两类结束态(有意):
 *  - interrupted:用户意图是「停」,自动重启违背打断语义
 *  - error / max_steps_exceeded:防 crash-loop 反复烧 token,由用户决定是否再推
 */
async function driveRun(session: AgentSession): Promise<void> {
  const { conversation, agent } = session;
  session.running = true;
  log.info({ conversationId: session.conversationId }, "开始 agent.run");
  try {
    // runtime 惰性化落点:第一次真正运行才起执行环境(建容器/连沙箱)。幂等,
    // 之后 no-op。放在 running 置位后、循环前:确保「有人真的要跑」才烧资源。
    await ensureRuntimeReady(session);

    while (true) {
      // per-run 换新 controller(AbortSignal 一次性,不可复位)
      session.runAbort = new AbortController();
      const r = await agent.run(conversation, {
        signal: session.runAbort.signal,
      });
      log.info(
        { conversationId: session.conversationId, status: r.status },
        "agent.run 结束"
      );
      if (
        r.status === "completed" &&
        hasUnseenUserMessage(session, r.projectedThroughSeq)
      ) {
        log.info(
          { conversationId: session.conversationId, watermark: r.projectedThroughSeq },
          "投影水位线后有未见用户消息,立即重跑"
        );
        continue;
      }
      break;
    }
  } catch (err) {
    // 意外异常兜底:emit 一条 error 事件让订阅者可见。
    // 打断不走此路径 —— run 已在检查点把 abort 转成正常返回。
    // emit 落盘也可能失败(如磁盘满),再包一层 try/catch:driveRun 是 fire-and-forget,
    // 绝不能让兜底 emit 的 rejection 冒泡成 unhandled rejection。
    try {
      await conversation.emit({
        type: "error",
        source: "agent",
        message: `运行出错：${(err as Error).message}`,
      });
    } catch (emitErr) {
      log.error(
        { conversationId: session.conversationId, err: emitErr },
        "兜底 error 事件落盘失败(磁盘/IO),仅记日志"
      );
    }
    log.error({ conversationId: session.conversationId, err }, "agent.run 异常");
  } finally {
    session.running = false;
    session.runAbort = null;
  }
}

/**
 * 水位线之后是否有未被本次 run 看过的用户消息。
 * 无需区分消息来源:agent 自产的引导 user_message(纯文字轮/finish 参数错)
 * emit 后必然 continue → 被下一次投影覆盖,故 completed 的最终水位线之后
 * 不可能残留 agent 自产消息,查 type 即可。
 */
function hasUnseenUserMessage(session: AgentSession, watermark: number): boolean {
  return session.conversation
    .getEventsSince(watermark)
    .some((e) => e.type === "user_message");
}
