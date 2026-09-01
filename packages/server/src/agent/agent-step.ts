import type { Conversation } from "../conversation/conversation.js";
import type { Event } from "../conversation/events.js";
import type { LLMClient } from "../llm/llm-client.js";
import type { LLMResponse } from "../llm/types.js";
import type { RunJournal } from "../observability/run-log.js";
import type { Runtime } from "../runtime/runtime.js";
import type { ToolContext, ToolRegistry } from "../tools/tool.js";
import type { ToolPolicyGetter } from "../tools/tool-policy.js";
import type { HumanInteractionCoordinator } from "../server/human-interaction.js";
import { AgentLLMCall } from "./agent-llm-call.js";
import { CompactionError } from "./context-compactor.js";
import {
  AgentLifecycle,
  AgentLifecycleError,
} from "./agent-lifecycle.js";
import { ToolCallExecutor, type ToolTrace } from "./tool-call-executor.js";

export interface AgentRunState {
  lastText: string;
  projectedThroughSeq: number;
}

export type AgentStepOutcome =
  | { type: "continue"; state: AgentRunState }
  | { type: "completed"; state: AgentRunState; result: string }
  | { type: "suspended"; state: AgentRunState }
  | { type: "interrupted"; state: AgentRunState }
  | { type: "error"; state: AgentRunState; error: string };

export interface AgentStepInput {
  conversation: Conversation;
  runId: string;
  runtime: Runtime;
  step: number;
  signal?: AbortSignal;
  previousState: AgentRunState;
}

export interface ResumeAgentStepInput {
  conversation: Conversation;
  runtime: Runtime;
  signal?: AbortSignal;
  agentMessage: Extract<Event, { type: "agent_message" }>;
}

interface AgentStepExecutorOptions {
  journal: RunJournal;
  lifecycle: AgentLifecycle;
  maxModelAttemptsPerStep?: number;
  interactions: HumanInteractionCoordinator;
  toolPolicyGetter?: ToolPolicyGetter;
}

/** 一个 ReAct step 的事务编排：固定快照、调用 LLM、提交响应并调度工具。 */
export class AgentStepExecutor {
  private readonly journal: RunJournal;
  private readonly lifecycle: AgentLifecycle;
  private readonly maxModelAttemptsPerStep: number;
  private readonly llmCall: AgentLLMCall;
  private readonly toolExecutor: ToolCallExecutor;

  constructor(
    llm: LLMClient,
    private readonly tools: ToolRegistry,
    options: AgentStepExecutorOptions
  ) {
    this.journal = options.journal;
    this.lifecycle = options.lifecycle;
    this.maxModelAttemptsPerStep = options.maxModelAttemptsPerStep ?? 1;
    if (
      !Number.isInteger(this.maxModelAttemptsPerStep) ||
      this.maxModelAttemptsPerStep < 1
    ) {
      throw new Error("maxModelAttemptsPerStep 必须是正整数");
    }
    this.llmCall = new AgentLLMCall(llm, options.journal);
    this.toolExecutor = new ToolCallExecutor(
      tools,
      options.journal,
      options.interactions,
      options.toolPolicyGetter
    );
  }

  async execute(input: AgentStepInput): Promise<AgentStepOutcome> {
    const { conversation, runId, runtime, step, signal, previousState } = input;

    // 投影、trigger 归因和 Compactor 必须共享这一份固定事件快照。
    const events = conversation.getEvents();
    let projectedThroughSeq = events.at(-1)?.seq ?? 0;
    const previousWatermark = this.journal.getLastAttributedEventSeq();
    const triggerIds = events
      .filter(
        (event): event is Extract<Event, { type: "user_message" }> & {
          triggerId: string;
        } =>
          event.type === "user_message" &&
          event.seq > previousWatermark &&
          event.seq <= projectedThroughSeq &&
          typeof event.triggerId === "string"
      )
      .map((event) => event.triggerId);
    await this.journal.append({
      type: "step_started",
      runId,
      step,
      projectedThroughSeq,
      triggerIds,
    });
    const stepStartedAt = Date.now();
    const completeStep = async (
      outcome: "continue" | "completed" | "error" | "interrupted"
    ) => {
      await this.journal.append({
        type: "step_completed",
        runId,
        step,
        outcome,
        durationMs: Date.now() - stepStartedAt,
      });
    };
    const state = (lastText: string): AgentRunState => ({
      lastText,
      projectedThroughSeq,
    });

    let prepared;
    try {
      prepared = await this.lifecycle.prepareContext({
        events,
        tools: this.tools.list(),
        runId,
        step,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        await completeStep("interrupted");
        return { type: "interrupted", state: state(previousState.lastText) };
      }
      if (error instanceof CompactionError) {
        await completeStep("error");
        return {
          type: "error",
          state: state(previousState.lastText),
          error: `上下文压缩失败：${error.code}`,
        };
      }
      return this.failLifecycle(
        conversation,
        completeStep,
        state(previousState.lastText),
        error
      );
    }
    if (signal?.aborted) {
      await completeStep("interrupted");
      return { type: "interrupted", state: state(previousState.lastText) };
    }

    let attempt = 1;
    let llmOutcome;
    while (true) {
      llmOutcome = await this.llmCall.execute({
        runId,
        step,
        projectedThroughSeq,
        messages: prepared.messages,
        systemContext: prepared.systemContext,
        tools: this.tools.list(),
        signal,
        onDelta: (delta) => conversation.emitDelta(delta),
      });
      if (llmOutcome.type !== "provider_error") break;
      if (signal?.aborted) {
        await completeStep("interrupted");
        return { type: "interrupted", state: state(previousState.lastText) };
      }
      if (attempt >= this.maxModelAttemptsPerStep) {
        await completeStep("error");
        throw llmOutcome.error;
      }
      let decision;
      try {
        decision = await this.lifecycle.resolveRequestError({
          error: llmOutcome.error,
          attempt,
        });
      } catch (error) {
        return this.failLifecycle(
          conversation,
          completeStep,
          state(previousState.lastText),
          error
        );
      }
      if (decision === "fail") {
        await completeStep("error");
        throw llmOutcome.error;
      }
      attempt++;
    }
    if (llmOutcome.type === "aborted") {
      await completeStep("interrupted");
      return { type: "interrupted", state: state(previousState.lastText) };
    }

    const { llmCallId, response } = llmOutcome;
    // Provider 正常返回和用户 abort 可能竞态；任何响应事件提交前必须再检查一次。
    if (signal?.aborted) {
      await this.journal.append({
        type: "llm_disposition",
        runId,
        step,
        llmCallId,
        disposition: "discarded",
        reason: "user_interrupt",
        eventSeqs: [],
      });
      await completeStep("interrupted");
      return { type: "interrupted", state: state(previousState.lastText) };
    }

    const lastText = response.text;
    const responseEventSeqs: number[] = [];
    let rejection;
    try {
      rejection = await this.lifecycle.inspectResponse(response.stopReason);
    } catch (error) {
      await this.journal.append({
        type: "llm_disposition",
        runId,
        step,
        llmCallId,
        disposition: "discarded",
        reason: "lifecycle_error",
        eventSeqs: [],
      });
      return this.failLifecycle(
        conversation,
        completeStep,
        state(lastText),
        error
      );
    }
    if (signal?.aborted) {
      await this.journal.append({
        type: "llm_disposition",
        runId,
        step,
        llmCallId,
        disposition: "discarded",
        reason: "user_interrupt",
        eventSeqs: [],
      });
      await completeStep("interrupted");
      return { type: "interrupted", state: state(previousState.lastText) };
    }
    if (rejection) {
      const errorEvent = await conversation.emit({
        type: "error",
        source: "agent",
        message: rejection.message,
      });
      responseEventSeqs.push(errorEvent.seq);
      await this.journal.append({
        type: "llm_disposition",
        runId,
        step,
        llmCallId,
        disposition: "rejected",
        reason: rejection.reason,
        eventSeqs: responseEventSeqs,
      });
      await completeStep("error");
      return {
        type: "error",
        state: state(lastText),
        error: rejection.message,
      };
    }

    // thinking 必须先于同轮 agent_message，保证投影时折叠进同一 assistant 消息。
    if (response.thinkingBlocks?.length) {
      const thinkingEvent = await conversation.emit({
        type: "thinking_completed",
        source: "agent",
        blocks: response.thinkingBlocks,
      });
      responseEventSeqs.push(thinkingEvent.seq);
    }

    const trace: ToolTrace = { runId, step, llmCallId, projectedThroughSeq };
    const agentEvent = await this.commitAgentMessage(conversation, response, trace);
    responseEventSeqs.push(agentEvent.seq);
    await this.recordCommittedDisposition(
      runId,
      step,
      llmCallId,
      responseEventSeqs
    );

    let plan;
    try {
      plan = await this.lifecycle.planCommittedResponse(response.toolCalls);
    } catch (error) {
      await this.skipPendingCallsForLifecycleError(
        conversation,
        response.toolCalls,
        { runId, step, llmCallId }
      );
      return this.failLifecycle(
        conversation,
        completeStep,
        state(lastText),
        error
      );
    }

    if (!plan && response.toolCalls.length === 0) {
      return this.failLifecycle(
        conversation,
        completeStep,
        state(lastText),
        new AgentLifecycleError(
          "committed_response",
          "unhandled-empty-response"
        )
      );
    }

    if (plan?.type === "continue") {
      await conversation.emit({
        type: "context_message",
        source: "environment",
        text: plan.contextMessage,
      });
      await completeStep("continue");
      return { type: "continue", state: state(lastText) };
    }

    const context: ToolContext = { runtime };
    if (plan?.type === "execute_completion_tool") {
      const completionCall = response.toolCalls.find(
        (call) => call.id === plan.toolCallId
      );
      if (!completionCall) {
        await this.skipPendingCallsForLifecycleError(
          conversation,
          response.toolCalls,
          trace
        );
        return this.failLifecycle(
          conversation,
          completeStep,
          state(lastText),
          new AgentLifecycleError(
            "committed_response",
            "missing-completion-tool"
          )
        );
      }
      const result = await this.toolExecutor.executeCall(
        conversation,
        completionCall,
        context,
        trace
      );
      if ("type" in result) {
        return { type: "suspended", state: state(lastText) };
      }
      for (const call of response.toolCalls) {
        if (call.id === completionCall.id) continue;
        await this.toolExecutor.skipCall(
          conversation,
          call,
          trace,
          "finish_called",
          "finish 已在本轮调用，该工具未执行"
        );
      }

      if (result.isError) {
        await conversation.emit({
          type: "context_message",
          source: "environment",
          text: plan.onErrorContextMessage,
        });
        await completeStep("continue");
        return { type: "continue", state: state(lastText) };
      }

      await conversation.emit({
        type: "agent_completed",
        source: "agent",
        result: result.content,
      });
      await completeStep("completed");
      return {
        type: "completed",
        state: state(lastText),
        result: result.content,
      };
    }

    const batchOutcome = await this.toolExecutor.executeCalls(
      conversation,
      response.toolCalls,
      context,
      trace,
      signal
    );
    if (batchOutcome.type === "interrupted") {
      await completeStep("interrupted");
      return { type: "interrupted", state: state(lastText) };
    }
    if (batchOutcome.type === "suspended") {
      return { type: "suspended", state: state(lastText) };
    }

    await completeStep("continue");
    return { type: "continue", state: state(lastText) };
  }

  /**
   * 从已提交的 agent_message 恢复同一个 step。恢复坐标只来自 Conversation Event；
   * Run Log 只接收补写记录，绝不参与恢复判断。
   */
  async resumeCommittedResponse(
    input: ResumeAgentStepInput
  ): Promise<AgentStepOutcome> {
    const { conversation, runtime, signal, agentMessage } = input;
    const trace = agentMessage.executionTrace;
    if (!trace) {
      return {
        type: "error",
        state: { lastText: agentMessage.text, projectedThroughSeq: 0 },
        error: "缺少工具调用恢复坐标",
      };
    }
    const state: AgentRunState = {
      lastText: agentMessage.text,
      projectedThroughSeq: trace.projectedThroughSeq,
    };
    const completeStep = async (
      outcome: "continue" | "completed" | "error" | "interrupted"
    ) => {
      await this.journal.append({
        type: "step_completed",
        runId: trace.runId,
        step: trace.step,
        outcome,
        durationMs: 0,
      });
    };

    let plan;
    try {
      plan = await this.lifecycle.planCommittedResponse(agentMessage.toolCalls);
    } catch (error) {
      await this.skipPendingCallsForLifecycleError(
        conversation,
        agentMessage.toolCalls,
        trace
      );
      return this.failLifecycle(conversation, completeStep, state, error);
    }

    if (plan?.type === "continue") {
      await conversation.emit({
        type: "context_message",
        source: "environment",
        text: plan.contextMessage,
      });
      await completeStep("continue");
      return { type: "continue", state };
    }

    const context: ToolContext = { runtime };
    if (plan?.type === "execute_completion_tool") {
      const completionCall = agentMessage.toolCalls.find(
        (call) => call.id === plan.toolCallId
      );
      if (!completionCall) {
        return this.failLifecycle(
          conversation,
          completeStep,
          state,
          new AgentLifecycleError("committed_response", "missing-completion-tool")
        );
      }
      const result = await this.toolExecutor.executeCall(
        conversation,
        completionCall,
        context,
        trace
      );
      if ("type" in result) return { type: "suspended", state };
      for (const call of agentMessage.toolCalls) {
        if (call.id === completionCall.id) continue;
        await this.toolExecutor.skipCall(
          conversation,
          call,
          trace,
          "finish_called",
          "finish 已在本轮调用，该工具未执行"
        );
      }
      if (result.isError) {
        await conversation.emit({
          type: "context_message",
          source: "environment",
          text: plan.onErrorContextMessage,
        });
        await completeStep("continue");
        return { type: "continue", state };
      }
      await conversation.emit({
        type: "agent_completed",
        source: "agent",
        result: result.content,
      });
      await completeStep("completed");
      return { type: "completed", state, result: result.content };
    }

    const batch = await this.toolExecutor.executeCalls(
      conversation,
      agentMessage.toolCalls,
      context,
      trace,
      signal
    );
    if (batch.type === "suspended") return { type: "suspended", state };
    if (batch.type === "interrupted") {
      await completeStep("interrupted");
      return { type: "interrupted", state };
    }
    await completeStep("continue");
    return { type: "continue", state };
  }

  private commitAgentMessage(
    conversation: Conversation,
    response: LLMResponse,
    executionTrace: ToolTrace
  ) {
    return conversation.emit({
      type: "agent_message",
      source: "agent",
      text: response.text,
      toolCalls: response.toolCalls,
      providerReplay: response.providerReplay,
      executionTrace,
    });
  }

  private recordCommittedDisposition(
    runId: string,
    step: number,
    llmCallId: string,
    eventSeqs: number[]
  ) {
    return this.journal.append({
      type: "llm_disposition",
      runId,
      step,
      llmCallId,
      disposition: "committed",
      eventSeqs,
    });
  }

  private async failLifecycle(
    conversation: Conversation,
    completeStep: (
      outcome: "continue" | "completed" | "error" | "interrupted"
    ) => Promise<void>,
    state: AgentRunState,
    error: unknown
  ): Promise<AgentStepOutcome> {
    const phase =
      error instanceof AgentLifecycleError ? error.phase : "prepare_context";
    const message = `Agent 生命周期扩展失败：${phase}`;
    await conversation.emit({
      type: "error",
      source: "agent",
      message,
    });
    await completeStep("error");
    return { type: "error", state, error: message };
  }

  private async skipPendingCallsForLifecycleError(
    conversation: Conversation,
    calls: LLMResponse["toolCalls"],
    trace: { runId: string; step: number; llmCallId: string }
  ): Promise<void> {
    for (const call of calls) {
      await this.toolExecutor.skipCall(
        conversation,
        call,
        trace,
        "lifecycle_error",
        "Agent 生命周期扩展失败，该工具未执行"
      );
    }
  }
}
