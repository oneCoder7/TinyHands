import type { Conversation } from "../conversation/conversation.js";
import type { Event } from "../conversation/events.js";
import type { AgentErrorHandler } from "./step/agent-error-handler.js";
import {
  type AgentRunState,
  type AgentStepOutcome,
  AgentStepExecutor,
} from "./step/agent-step-executor.js";

export type RunStatus =
  | "completed"
  | "max_steps_exceeded"
  | "error"
  | "interrupted"
  | "suspended";

export interface RunResult {
  status: RunStatus;
  result?: string;
  lastText: string;
  trajectory: Event[];
  error?: string;
  projectedThroughSeq: number;
}

export interface AgentRunContext {
  runId: string;
  signal?: AbortSignal;
}

export interface AgentResumeContext extends AgentRunContext {
  agentMessage: Extract<Event, { type: "agent_message" }>;
}

/** Run 级循环；Conversation 固定依赖均已在 createAgent() 装配时绑定。 */
export class Agent {
  constructor(
    private readonly conversation: Conversation,
    private readonly stepExecutor: AgentStepExecutor,
    private readonly errorHandler: AgentErrorHandler,
    private readonly maxStep: number
  ) {
    if (!Number.isInteger(maxStep) || maxStep < 1) {
      throw new Error("maxStep 必须是正整数");
    }
  }

  run(context: AgentRunContext): Promise<RunResult> {
    return this.runSteps(context, 0, { lastText: "", projectedThroughSeq: 0 });
  }

  async resume(context: AgentResumeContext): Promise<RunResult> {
    const trace = context.agentMessage.executionTrace;
    if (!trace || trace.runId !== context.runId) {
      return {
        status: "error",
        lastText: context.agentMessage.text,
        trajectory: this.conversation.getEvents(),
        error: "工具调用恢复坐标不合法",
        projectedThroughSeq: trace?.projectedThroughSeq ?? 0,
      };
    }
    const outcome = await this.stepExecutor.resumeCommittedResponse({
      signal: context.signal,
      agentMessage: context.agentMessage,
    });
    if (outcome.type !== "continue") return this.toRunResult(outcome);
    return this.runSteps(context, trace.step + 1, outcome.state);
  }

  private async runSteps(
    context: AgentRunContext,
    startStep: number,
    initialState: AgentRunState
  ): Promise<RunResult> {
    let state = initialState;
    for (let step = startStep; step < this.maxStep; step++) {
      if (context.signal?.aborted) return this.interruptedResult(state);

      let outcome: AgentStepOutcome;
      try {
        outcome = await this.stepExecutor.execute({
          runId: context.runId,
          step,
          signal: context.signal,
          previousState: state,
        });
      } catch (error) {
        const failure = await this.errorHandler.handle({
          source: "unknown",
          error,
          coordinates: {
            runId: context.runId,
            step,
            projectedThroughSeq: state.projectedThroughSeq,
          },
        });
        return {
          status: "error",
          lastText: state.lastText,
          trajectory: this.conversation.getEvents(),
          error: failure.type === "error" ? failure.message : "Agent 执行失败",
          projectedThroughSeq: state.projectedThroughSeq,
        };
      }
      state = outcome.state;
      if (outcome.type === "continue") continue;
      return this.toRunResult(outcome);
    }

    if (context.signal?.aborted) return this.interruptedResult(state);
    const message = `达到最大步数 ${this.maxStep}，任务未显式完成`;
    await this.conversation.emit({ type: "error", source: "agent", message });
    return {
      status: "max_steps_exceeded",
      lastText: state.lastText,
      trajectory: this.conversation.getEvents(),
      error: message,
      projectedThroughSeq: state.projectedThroughSeq,
    };
  }

  private interruptedResult(state: AgentRunState): RunResult {
    return {
      status: "interrupted",
      lastText: state.lastText,
      trajectory: this.conversation.getEvents(),
      projectedThroughSeq: state.projectedThroughSeq,
    };
  }

  private toRunResult(
    outcome: Exclude<AgentStepOutcome, { type: "continue" }>
  ): RunResult {
    const base = {
      lastText: outcome.state.lastText,
      trajectory: this.conversation.getEvents(),
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
}
