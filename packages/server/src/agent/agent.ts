import type { Conversation } from "../conversation/conversation.js";
import type { Event } from "../conversation/events.js";
import type { LLMClient } from "../llm/llm-client.js";
import type { RunJournal } from "../observability/run-log.js";
import type { Runtime } from "../runtime/runtime.js";
import type { ToolRegistry } from "../tools/tool.js";
import type { ToolPolicyGetter } from "../tools/tool-policy.js";
import { HumanInteractionCoordinator } from "../server/human-interaction.js";
import {
  AgentStepExecutor,
  type AgentRunState,
  type AgentStepOutcome,
} from "./agent-step.js";
import {
  AgentLifecycle,
  createBuiltInAgentLifecycle,
} from "./agent-lifecycle.js";

export type RunStatus =
  | "completed"
  | "max_steps_exceeded"
  | "error"
  | "interrupted"
  | "suspended";

export interface RunResult {
  status: RunStatus;
  /** finish 的结构化结果（completed 时有） */
  result?: string;
  /** 最后一轮的文字（兜底展示） */
  lastText: string;
  /** 完整可审计轨迹 —— 由事件流提供(事件是真相源) */
  trajectory: Event[];
  /** error 时的原因 */
  error?: string;
  /** 本次 run 最后一次投影覆盖到的事件 seq —— lost-wakeup 水位线。 */
  projectedThroughSeq: number;
}

export interface AgentOptions {
  maxStep?: number;
  journal: RunJournal;
  /** server-internal；每个 AgentSession 必须持有独立实例。 */
  lifecycle?: AgentLifecycle;
  maxModelAttemptsPerStep?: number;
  toolPolicyGetter?: ToolPolicyGetter;
}

/** 单次 Agent run 所需的进程内能力；不进入 Conversation 持久状态。 */
export interface AgentRunContext {
  runId: string;
  runtime: Runtime;
  signal?: AbortSignal;
}

export interface AgentResumeContext extends AgentRunContext {
  agentMessage: Extract<Event, { type: "agent_message" }>;
}

/** Agent 是 ReAct run 的公共 facade；单步事务由 AgentStepExecutor 完成。 */
export class Agent {
  private readonly maxStep: number;
  private readonly stepExecutor: AgentStepExecutor;

  constructor(llm: LLMClient, tools: ToolRegistry, options: AgentOptions) {
    this.maxStep = options.maxStep ?? 10;
    this.stepExecutor = new AgentStepExecutor(llm, tools, {
      journal: options.journal,
      lifecycle: options.lifecycle ?? createBuiltInAgentLifecycle(),
      maxModelAttemptsPerStep: options.maxModelAttemptsPerStep,
      interactions: new HumanInteractionCoordinator(),
      toolPolicyGetter: options.toolPolicyGetter,
    });
  }

  async run(
    conversation: Conversation,
    context: AgentRunContext
  ): Promise<RunResult> {
    return this.runSteps(conversation, context, 0, {
      lastText: "",
      projectedThroughSeq: 0,
    });
  }

  async resume(
    conversation: Conversation,
    context: AgentResumeContext
  ): Promise<RunResult> {
    const trace = context.agentMessage.executionTrace;
    if (!trace || trace.runId !== context.runId) {
      return {
        status: "error",
        lastText: context.agentMessage.text,
        trajectory: conversation.getEvents(),
        error: "工具调用恢复坐标不合法",
        projectedThroughSeq: trace?.projectedThroughSeq ?? 0,
      };
    }
    const outcome = await this.stepExecutor.resumeCommittedResponse({
      conversation,
      runtime: context.runtime,
      signal: context.signal,
      agentMessage: context.agentMessage,
    });
    if (outcome.type !== "continue") return toRunResult(conversation, outcome);
    return this.runSteps(
      conversation,
      context,
      trace.step + 1,
      outcome.state
    );
  }

  private async runSteps(
    conversation: Conversation,
    context: AgentRunContext,
    startStep: number,
    initialState: AgentRunState
  ): Promise<RunResult> {
    let state = initialState;

    for (let step = startStep; step < this.maxStep; step++) {
      // 上一步配对已闭合；步首打断无需创建虚假的 step 生命周期。
      if (context.signal?.aborted) {
        return interruptedResult(conversation, state);
      }

      const outcome = await this.stepExecutor.execute({
        conversation,
        runId: context.runId,
        runtime: context.runtime,
        step,
        signal: context.signal,
        previousState: state,
      });
      state = outcome.state;

      if (outcome.type === "continue") continue;
      return toRunResult(conversation, outcome);
    }

    // 接住最后一步最后一个工具执行期间发生的打断。
    if (context.signal?.aborted) {
      return interruptedResult(conversation, state);
    }

    await conversation.emit({
      type: "error",
      source: "agent",
      message: `达到最大步数 ${this.maxStep}，任务未显式完成`,
    });
    return {
      status: "max_steps_exceeded",
      lastText: state.lastText,
      trajectory: conversation.getEvents(),
      error: `达到最大步数 ${this.maxStep}，任务未显式完成`,
      projectedThroughSeq: state.projectedThroughSeq,
    };
  }
}

function interruptedResult(
  conversation: Conversation,
  state: AgentRunState
): RunResult {
  return {
    status: "interrupted",
    lastText: state.lastText,
    trajectory: conversation.getEvents(),
    projectedThroughSeq: state.projectedThroughSeq,
  };
}

function toRunResult(
  conversation: Conversation,
  outcome: Exclude<AgentStepOutcome, { type: "continue" }>
): RunResult {
  const base = {
    lastText: outcome.state.lastText,
    trajectory: conversation.getEvents(),
    projectedThroughSeq: outcome.state.projectedThroughSeq,
  };
  switch (outcome.type) {
    case "completed":
      return { status: "completed", result: outcome.result, ...base };
    case "interrupted":
      return { status: "interrupted", ...base };
    case "suspended":
      return { status: "suspended", ...base };
    case "error":
      return { status: "error", error: outcome.error, ...base };
  }
}
