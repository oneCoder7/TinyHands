import type { LLMClient } from "../llm/llm-client.js";
import { randomUUID } from "node:crypto";
import { Conversation } from "../conversation/conversation.js";
import type { Event } from "../conversation/events.js";
import { findUnmatchedToolCalls } from "../conversation/events.js";
import type {
  ConversationRecord,
  ConversationStore,
} from "../conversation/conversation-store.js";
import { Agent, type RunStatus } from "../agent/agent.js";
import { LocalRuntime } from "../runtime/local-runtime.js";
import { DockerRuntime } from "../runtime/docker-runtime.js";
import { OpenSandboxRuntime } from "../runtime/opensandbox-runtime.js";
import { ToolRegistry } from "../tools/tool.js";
import { readFileTool } from "../tools/read-file.js";
import { writeFileTool } from "../tools/write-file.js";
import { finishTool } from "../tools/finish.js";
import { optionalToolCatalog } from "../tools/catalog.js";
import { RunJournal } from "../observability/run-log.js";
import type { RunLogStore } from "../observability/run-log-store.js";
import type {
  AutoCompactConfig,
  TinyhandsRuntimeConfig,
} from "./options.js";
import { ContextCompactor } from "../agent/context-compactor.js";
import type { Runtime } from "../runtime/runtime.js";
import {
  noopLogger,
  type TinyhandsLogger,
} from "../logging/logger.js";

/**
 * AgentSession —— 一个会话的集束层:运行时组件 + 运行期簿记捆成一个具名结构。
 *
 * 住 server/ 而非 conversation/:它同时引用 Conversation 与 Agent,放 conversation/
 * 会与 agent → conversation 的单向依赖形成目录级循环;且 running/createdAt 是
 * 「会话在服务端运行」才有的簿记,本质是两个内核之上的管理层。
 *
 * Conversation 与 Agent 分离:持久状态(事件历史)与运行行为(prompt/工具/循环控制)
 * 解耦,换/多 agent 时状态不动。成对持有的代价由这个集束层吸收。
 */
interface AgentSessionState {
  agent: Agent;
  journal: RunJournal;
  runtime: Runtime;
  running: boolean;
  runAbort: AbortController | null;
  lastInterruptSeq: number | null;
  drivePromise: Promise<void> | null;
  closing: boolean;
  closePromise: Promise<void> | null;
  runtimeStarted: boolean;
  log: TinyhandsLogger;
}

const SESSION_STATE = new WeakMap<AgentSession, AgentSessionState>();

/**
 * 单 Conversation 在当前 Host 进程内的执行实例。
 *
 * 运行状态、Agent、Journal 与 AbortController 全部藏在模块私有 WeakMap 中；调用方
 * 只能通过 submit/interrupt/close 改变状态，不能伪造 running 或替换中止句柄。
 * Conversation 暂保留为 server-internal 只读入口，供恢复补偿与公开事件订阅使用；
 * 它不会进入未来 package exports。
 */
export class AgentSession {
  readonly conversationId: string;
  readonly conversation: Conversation;
  readonly conversationCreatedAt: number;

  constructor(opts: {
    conversationId: string;
    conversation: Conversation;
    conversationCreatedAt: number;
    agent: Agent;
    journal: RunJournal;
    runtime: Runtime;
    logger?: TinyhandsLogger;
  }) {
    this.conversationId = opts.conversationId;
    this.conversation = opts.conversation;
    this.conversationCreatedAt = opts.conversationCreatedAt;
    SESSION_STATE.set(this, {
      agent: opts.agent,
      journal: opts.journal,
      runtime: opts.runtime,
      running: false,
      runAbort: null,
      lastInterruptSeq: null,
      drivePromise: null,
      closing: false,
      closePromise: null,
      runtimeStarted: false,
      log: (opts.logger ?? noopLogger).child({ module: "agent-session" }),
    });
  }

  get running(): boolean {
    return stateOf(this).running;
  }

  /** 只读诊断值；写侧封装在 ensureRuntimeReady。 */
  get runtimeStarted(): boolean {
    return stateOf(this).runtimeStarted;
  }

  submit(text: string): Promise<SubmitResult> {
    return submitUserMessage(this, text);
  }

  interrupt(): Promise<boolean> {
    return interruptRun(this);
  }

  close(): Promise<void> {
    return closeAgentSession(this);
  }
}

function stateOf(session: AgentSession): AgentSessionState {
  const state = SESSION_STATE.get(session);
  if (!state) throw new Error("非法 AgentSession 实例");
  return state;
}

/**
 * 装配端口 —— manager 通过它「拿数据造会话」,自己从不 new 组件。
 * 每会话数据(conversationId/workspaceDir)作参数流动;进程级依赖(llm/maxStep)
 * 由下面工厂闭包捕获,不穿透 manager。
 *
 * initialEvents:恢复(resume)场景由 Service 从 ConversationStore load 后传入,灌进 EventStream
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
  initialRecord?: ConversationRecord;
}) => Promise<AgentSession>;

/**
 * 生产侧工厂 —— 进程级依赖注入一次,返回一个 SessionFactory。
 * 全项目唯一串起内核 + runtime + 工具具体实现的地方。runtime 按 config.runtime 选择。
 */
export function makeAgentSessionFactory(deps: {
  llm: LLMClient;
  maxStep: number;
  runtime: TinyhandsRuntimeConfig;
  dockerInstanceScope?: string;
  logger?: TinyhandsLogger;
  /** 事件持久化:落盘 + 恢复。注入给每个会话的 Conversation。 */
  conversationStore: ConversationStore;
  /** 执行追踪持久化:每会话 run_log.jsonl。 */
  runLogStore: RunLogStore;
  autoCompact?: {
    config: AutoCompactConfig;
    maxOutputTokens: number;
  };
}): SessionFactory {
  return async ({
    conversationId,
    workspaceDir,
    tools: toolNames,
    initialEvents,
    initialRecord,
  }) => {
    // ① 组装 ToolRegistry:必选 3 个 + 可选工具。
    //   优先级:调用方传入(新建) > initialRecord.tools(恢复) > 默认 ["run_bash"]
    const enabledTools = toolNames ?? initialRecord?.tools ?? ["run_bash"];
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

    const journal = await RunJournal.open(conversationId, deps.runLogStore);
    await journal.recoverOpenRuns();
    const agent = new Agent(deps.llm, registry, {
      maxStep: deps.maxStep,
      journal,
      ...(deps.autoCompact
        ? {
            compactor: new ContextCompactor(
              deps.llm,
              journal,
              deps.autoCompact.config,
              deps.autoCompact.maxOutputTokens
            ),
          }
        : {}),
    });

    // ② 按配置选择执行环境——这里是唯一的 runtime 分叉点。
    //    注意:此处只 new 对象(构造无副作用),不 create()。runtime 惰性化 ——
    //    首次 driveRun 经 ensureRuntimeReady 才真正起环境(建容器/连沙箱)。
    //    故「建会话记录」「读历史/恢复」都不烧容器。
    const runtime = (() => {
      switch (deps.runtime.type) {
        case "docker":
          if (!deps.dockerInstanceScope) {
            throw new Error("Docker runtime 缺少 instance scope");
          }
          return new DockerRuntime({
            image: deps.runtime.image,
            conversationId,
            instanceScope: deps.dockerInstanceScope,
            logger: deps.logger,
          });
        case "opensandbox":
          return new OpenSandboxRuntime({
            serverUrl: deps.runtime.serverUrl,
            apiKey: deps.runtime.apiKey,
            image: deps.runtime.image,
            logger: deps.logger,
          });
        default:
          return new LocalRuntime({ cwd: workspaceDir });
      }
    })();

    // Conversation 接 Store 的事件追加端口:emit 落盘;initialEvents 灌入恢复历史。
    const conversation = new Conversation(conversationId, {
      store: deps.conversationStore,
      initialEvents,
      logger: deps.logger,
    });
    return new AgentSession({
      conversationId,
      conversation,
      agent,
      journal,
      runtime,
      logger: deps.logger,
      // 恢复时用原创建时间;新建用当前时间。
      conversationCreatedAt: initialRecord?.createdAt ?? Date.now(),
    });
  };
}

/**
 * 确保执行环境就绪 —— runtime 惰性化的落点。幂等:只在首次真正运行时 create,
 * 之后 no-op。把「起重型执行环境」绑定到「第一次真正运行」而非「建会话记录」,
 * 让建会话/读历史/恢复都零 runtime 副作用。
 */
async function ensureRuntimeReady(session: AgentSession): Promise<void> {
  const state = stateOf(session);
  if (state.runtimeStarted) return;
  await state.runtime.create();
  state.runtimeStarted = true;
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
export interface SubmitResult {
  triggerId: string;
  userMessageSeq: number;
}

async function submitUserMessage(
  session: AgentSession,
  text: string
): Promise<SubmitResult> {
  const state = stateOf(session);
  if (state.closing) throw new Error("AgentSession 正在关闭");
  const triggerId = randomUUID();
  // ① 用户消息入事件流(await 落盘成功后才广播给所有订阅者)
  const event = await session.conversation.emit({
    type: "user_message",
    source: "user",
    text,
    triggerId,
  });

  // ② 已有 run 在跑:消息已入流,不重复触发。它若落在当前 run 最后一次投影之后,
  //    run 结束时 driveRun 会按水位线发现并立即重跑(lost-wakeup 的正解)。
  if (state.running) {
    state.log.info(
      { conversationId: session.conversationId },
      "已有 run 在跑,新消息已入事件流,本次不重复触发"
    );
    return { triggerId, userMessageSeq: event.seq };
  }

  // ③ 后台驱动(fire-and-forget;异常已在 driveRun 内兜底,不会成为未处理 rejection)
  const driver = driveRun(session);
  state.drivePromise = driver;
  void driver.finally(() => {
    if (state.drivePromise === driver) state.drivePromise = null;
  });
  return { triggerId, userMessageSeq: event.seq };
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
async function interruptRun(session: AgentSession): Promise<boolean> {
  const state = stateOf(session);
  if (state.closing) return false;
  if (!state.running || !state.runAbort) return false; // 空闲:无事可断
  if (state.runAbort.signal.aborted) return false; // 已在打断中:去重
  // 先留痕再拉闸:interrupted 先入流,订阅者先看到「用户打断了」,
  // 随后才是检查点③可能补的 isError tool_result。
  const event = await session.conversation.emit({
    type: "interrupted",
    source: "user",
  });
  state.lastInterruptSeq = event.seq;
  state.runAbort.abort();
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
  const { conversation } = session;
  const state = stateOf(session);
  const { agent, journal } = state;
  state.running = true;
  state.log.info({ conversationId: session.conversationId }, "开始 agent.run");
  try {
    while (true) {
      const runId = randomUUID();
      // 必须先持久化 started，再启动 runtime 或 Agent 副作用。
      await journal.append({ type: "run_started", runId });
      const runStartedAt = Date.now();

      let r: Awaited<ReturnType<Agent["run"]>>;
      try {
        // runtime 惰性化落点:第一次真正运行才起执行环境。放在 run_started 之后，
        // 这样日志落盘失败不会启动外部执行环境。
        await ensureRuntimeReady(session);
        state.runAbort = new AbortController();
        r = await agent.run(conversation, {
          signal: state.runAbort.signal,
          runId,
          runtime: state.runtime,
        });
      } catch (err) {
        try {
          await journal.append({
            type: "run_completed",
            runId,
            status: "error",
            projectedThroughSeq: projectedThroughForRun(journal, runId),
            durationMs: Date.now() - runStartedAt,
            errorCode: "agent_run_failed",
          });
        } catch (journalErr) {
          state.log.error(
            { conversationId: session.conversationId, runId, err: journalErr },
            "run_completed(error) 落盘失败"
          );
        }
        throw err;
      }

      try {
        const errorCode = runErrorCode(r.status);
        await journal.append({
          type: "run_completed",
          runId,
          status: r.status,
          projectedThroughSeq: r.projectedThroughSeq,
          durationMs: Date.now() - runStartedAt,
          ...(errorCode ? { errorCode } : {}),
        });
      } catch (err) {
        // 业务结果已经由 events.jsonl 定稿，不能因追踪终态写失败而回滚或重跑。
        // 未闭合 run 会在进程重启时由 recoverOpenRuns 标成 process_crashed。
        state.log.error(
          { conversationId: session.conversationId, runId, err },
          "run_completed 落盘失败，停止继续驱动"
        );
        break;
      }
      state.log.info(
        { conversationId: session.conversationId, runId, status: r.status },
        "agent.run 结束"
      );
      if (state.closing) break;
      const restartAfterInterrupt =
        r.status === "interrupted" &&
        state.lastInterruptSeq !== null &&
        hasUnseenUserMessage(session, state.lastInterruptSeq);
      if (
        (r.status === "completed" &&
          hasUnseenUserMessage(session, r.projectedThroughSeq)) ||
        restartAfterInterrupt
      ) {
        state.log.info(
          {
            conversationId: session.conversationId,
            watermark: restartAfterInterrupt
              ? state.lastInterruptSeq
              : r.projectedThroughSeq,
          },
          restartAfterInterrupt
            ? "interrupt 后有新用户消息,立即重跑"
            : "投影水位线后有未见用户消息,立即重跑"
        );
        state.lastInterruptSeq = null;
        continue;
      }
      if (r.status === "interrupted") state.lastInterruptSeq = null;
      break;
    }
  } catch (err) {
    // 意外异常兜底:emit 一条 error 事件让订阅者可见。
    // 打断不走此路径 —— run 已在检查点把 abort 转成正常返回。
    // emit 落盘也可能失败(如磁盘满),再包一层 try/catch:driveRun 是 fire-and-forget,
    // 绝不能让兜底 emit 的 rejection 冒泡成 unhandled rejection。
    if (!state.closing) {
      try {
        await conversation.emit({
          type: "error",
          source: "agent",
          message: `运行出错：${(err as Error).message}`,
        });
      } catch (emitErr) {
        state.log.error(
          { conversationId: session.conversationId, err: emitErr },
          "兜底 error 事件落盘失败(磁盘/IO),仅记日志"
        );
      }
    }
    state.log.error(
      { conversationId: session.conversationId, err },
      "agent.run 异常"
    );
  } finally {
    state.running = false;
    state.runAbort = null;
  }
}

/**
 * 让 Session 静止并释放 Runtime，但不删除 Conversation 数据。
 * delete 与未来 Host.close 共用这一条关闭路径。
 */
function closeAgentSession(session: AgentSession): Promise<void> {
  const state = stateOf(session);
  if (state.closePromise) return state.closePromise;
  state.closing = true;
  state.runAbort?.abort();
  const close = (async () => {
    await state.drivePromise;
    await state.runtime.kill();
  })();
  state.closePromise = close;
  void close.then(undefined, () => {
    // 保持 closing=true 拒绝新工作，但允许 delete/Host.close 重试资源清理。
    if (state.closePromise === close) state.closePromise = null;
  });
  return close;
}

function runErrorCode(status: RunStatus): string | undefined {
  if (status === "error") return "agent_run_error";
  if (status === "max_steps_exceeded") return "max_steps_exceeded";
  return undefined;
}

function projectedThroughForRun(journal: RunJournal, runId: string): number {
  for (const record of journal.getRecords().reverse()) {
    if (record.type === "step_started" && record.runId === runId) {
      return record.projectedThroughSeq;
    }
  }
  return 0;
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
