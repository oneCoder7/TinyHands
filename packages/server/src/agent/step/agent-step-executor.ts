import type { Conversation } from "../../conversation/conversation.js";
import type { Event } from "../../conversation/events.js";
import type { LLMResponse } from "../../llm/types.js";
import type { RunJournal } from "../../observability/run-log.js";
import type { Tool } from "../../tools/tool.js";
import { AgentLLMCall } from "./agent-llm-call.js";
import { CompactionError } from "../context/context-compactor.js";
import type {
  AgentStepCoordinates,
  ContextPreparation,
} from "../context/context-preparation.js";
import { AgentErrorHandler } from "./agent-error-handler.js";
import type { CompletionHandler } from "./completion-handler.js";
import {
  validateResponse,
  type ResponseValidator,
} from "./response-validator.js";
import type {
  ToolCallHandler,
  ToolTrace,
} from "./tool-call/tool-call-handler.js";

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
  runId: string;
  step: number;
  signal?: AbortSignal;
  previousState: AgentRunState;
}

export interface ResumeAgentStepInput {
  signal?: AbortSignal;
  agentMessage: Extract<Event, { type: "agent_message" }>;
}

export interface AgentStepExecutorOptions {
  conversation: Conversation;
  tools: readonly Tool[];
  journal: RunJournal;
  contextPreparation: ContextPreparation;
  llmCall: AgentLLMCall;
  responseValidators: readonly ResponseValidator[];
  completionHandler: CompletionHandler;
  toolCallHandler: ToolCallHandler;
  errorHandler: AgentErrorHandler;
}

/**
 * 一个 ReAct Step 的固定编排器。
 *
 * 固定顺序：冻结输入边界 → 构建 Context → 调用模型 → 校验并提交响应 →
 * 处理完成协议或普通 ToolCall → 闭合 Step。所有业务事实只由这里或受控 Handler 提交；
 * Run Log 只记录执行轨迹，绝不作为消息与恢复的真相源。
 */
export class AgentStepExecutor {
  private readonly conversation: Conversation;
  private readonly tools: readonly Tool[];
  private readonly journal: RunJournal;
  private readonly contextPreparation: ContextPreparation;
  private readonly llmCall: AgentLLMCall;
  private readonly responseValidators: readonly ResponseValidator[];
  private readonly completionHandler: CompletionHandler;
  private readonly toolCallHandler: ToolCallHandler;
  private readonly errorHandler: AgentErrorHandler;

  constructor(options: AgentStepExecutorOptions) {
    this.conversation = options.conversation;
    this.tools = [...options.tools];
    this.journal = options.journal;
    this.contextPreparation = options.contextPreparation;
    this.llmCall = options.llmCall;
    this.responseValidators = [...options.responseValidators];
    this.completionHandler = options.completionHandler;
    this.toolCallHandler = options.toolCallHandler;
    this.errorHandler = options.errorHandler;
  }

  async execute(input: AgentStepInput): Promise<AgentStepOutcome> {
    // 1. Step 开始后新到达的 Event 不进入本轮请求；Context、trigger 和水位线共享快照。
    const events = this.conversation.getEvents();
    const projectedThroughSeq = events.at(-1)?.seq ?? 0;
    const coordinates: AgentStepCoordinates = {
      runId: input.runId,
      step: input.step,
      projectedThroughSeq,
    };
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
      runId: input.runId,
      step: input.step,
      projectedThroughSeq,
      triggerIds,
    });

    const startedAt = Date.now();
    let completed = false;
    const complete = async (
      outcome: "continue" | "completed" | "error" | "interrupted"
    ) => {
      if (completed) return;
      await this.journal.append({
        type: "step_completed",
        runId: input.runId,
        step: input.step,
        outcome,
        durationMs: Date.now() - startedAt,
      });
      completed = true;
    };
    const state = (lastText: string): AgentRunState => ({
      lastText,
      projectedThroughSeq,
    });

    try {
    // 2. Context Preparation 是唯一的模型请求构建入口，Auto Compact 也在该边界内完成。
    let prepared;
    try {
      prepared = await this.contextPreparation.prepare({
        events,
        coordinates,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) {
        await complete("interrupted");
        return { type: "interrupted", state: state(input.previousState.lastText) };
      }
      if (error instanceof CompactionError) {
        const message = `上下文压缩失败：${error.code}`;
        await complete("error");
        return { type: "error", state: state(input.previousState.lastText), error: message };
      }
      const failure = await this.errorHandler.handle({
        source: "context",
        error,
        coordinates,
      });
      await complete("error");
      return {
        type: "error",
        state: state(input.previousState.lastText),
        error: terminalMessage(failure),
      };
    }
    if (input.signal?.aborted) {
      await complete("interrupted");
      return { type: "interrupted", state: state(input.previousState.lastText) };
    }

    // 3. 每次模型失败（包括达到上限的最后一次）都先交给 AgentErrorHandler 收敛。
    let attempt = 1;
    let response: LLMResponse;
    let trace: ToolTrace;
    while (true) {
      const outcome = await this.llmCall.execute({
        runId: input.runId,
        step: input.step,
        projectedThroughSeq,
        messages: prepared.messages,
        systemContext: prepared.systemContext,
        tools: [...this.tools],
        signal: input.signal,
        onDelta: (delta) => this.conversation.emitDelta(delta),
      });
      if (outcome.type === "aborted") {
        await complete("interrupted");
        return { type: "interrupted", state: state(input.previousState.lastText) };
      }
      trace = {
        runId: input.runId,
        step: input.step,
        llmCallId: outcome.llmCallId,
        projectedThroughSeq,
      };
      if (outcome.type === "completed") {
        response = outcome.response;
        break;
      }
      const failure = await this.errorHandler.handle({
        source: "model_request",
        error: outcome.error,
        attempt,
        trace,
      });
      if (failure.type === "retry") {
        attempt += 1;
        continue;
      }
      await complete("error");
      return { type: "error", state: state(input.previousState.lastText), error: failure.message };
    }

    // 4. Provider 正常返回与 abort 可能竞态；任何响应 Event 提交前都必须再次检查。
    if (input.signal?.aborted) {
      await this.recordDiscarded(trace, "user_interrupt");
      await complete("interrupted");
      return { type: "interrupted", state: state(input.previousState.lastText) };
    }

    let rejection;
    try {
      rejection = await validateResponse(this.responseValidators, response.stopReason);
    } catch (error) {
      await this.recordDiscarded(trace, "agent_error");
      const failure = await this.errorHandler.handle({ source: "response", error, trace });
      await complete("error");
      return { type: "error", state: state(response.text), error: terminalMessage(failure) };
    }
    if (input.signal?.aborted) {
      await this.recordDiscarded(trace, "user_interrupt");
      await complete("interrupted");
      return { type: "interrupted", state: state(input.previousState.lastText) };
    }
    if (rejection) {
      const errorEvent = await this.conversation.emit({
        type: "error",
        source: "agent",
        message: rejection.message,
      });
      await this.journal.append({
        type: "llm_disposition",
        runId: trace.runId,
        step: trace.step,
        llmCallId: trace.llmCallId,
        disposition: "rejected",
        reason: rejection.reason,
        eventSeqs: [errorEvent.seq],
      });
      await complete("error");
      return { type: "error", state: state(response.text), error: rejection.message };
    }

    // 5. thinking 与 agent_message 原子地构成可信模型事实；disposition 只做审计配对。
    const responseEventSeqs: number[] = [];
    if (response.thinkingBlocks?.length) {
      const event = await this.conversation.emit({
        type: "thinking_completed",
        source: "agent",
        blocks: response.thinkingBlocks,
      });
      responseEventSeqs.push(event.seq);
    }
    const agentMessage = await this.conversation.emit({
      type: "agent_message",
      source: "agent",
      text: response.text,
      toolCalls: response.toolCalls,
      providerReplay: response.providerReplay,
      executionTrace: trace,
    });
    responseEventSeqs.push(agentMessage.seq);
    await this.journal.append({
      type: "llm_disposition",
      runId: trace.runId,
      step: trace.step,
      llmCallId: trace.llmCallId,
      disposition: "committed",
      eventSeqs: responseEventSeqs,
    });

    // 6. 正常执行与 approval/进程恢复共用同一个已提交响应处理入口。
    return await this.handleCommittedResponse(
      response,
      trace,
      input.signal,
      state(response.text),
      complete
    );
    } catch (error) {
      if (input.signal?.aborted) {
        await complete("interrupted");
        return { type: "interrupted", state: state(input.previousState.lastText) };
      }
      const failure = await this.errorHandler.handle({
        source: "unknown",
        error,
        coordinates,
      });
      await complete("error");
      return {
        type: "error",
        state: state(input.previousState.lastText),
        error: terminalMessage(failure),
      };
    }
  }

  async resumeCommittedResponse(input: ResumeAgentStepInput): Promise<AgentStepOutcome> {
    const trace = input.agentMessage.executionTrace;
    if (!trace) {
      return {
        type: "error",
        state: { lastText: input.agentMessage.text, projectedThroughSeq: 0 },
        error: "缺少工具调用恢复坐标",
      };
    }
    const state: AgentRunState = {
      lastText: input.agentMessage.text,
      projectedThroughSeq: trace.projectedThroughSeq,
    };
    const complete = async (
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
    const response: LLMResponse = {
      stopReason: input.agentMessage.toolCalls.length ? "tool_call" : "end_turn",
      text: input.agentMessage.text,
      toolCalls: input.agentMessage.toolCalls,
      providerReplay: input.agentMessage.providerReplay,
      usage: { status: "not_reported" },
    };
    return this.handleCommittedResponse(response, trace, input.signal, state, complete);
  }

  private async handleCommittedResponse(
    response: LLMResponse,
    trace: ToolTrace,
    signal: AbortSignal | undefined,
    state: AgentRunState,
    complete: (outcome: "continue" | "completed" | "error" | "interrupted") => Promise<void>
  ): Promise<AgentStepOutcome> {
    let completion;
    try {
      completion = await this.completionHandler.handle({ response, trace, signal });
    } catch (error) {
      const failure = await this.errorHandler.handle({
        source: "completion",
        error,
        trace,
        committedToolCalls: response.toolCalls,
      });
      await complete("error");
      return { type: "error", state, error: terminalMessage(failure) };
    }

    if (completion) {
      switch (completion.type) {
        case "continue":
          await this.conversation.emit({
            type: "context_message",
            source: "environment",
            text: completion.contextMessage,
          });
          await complete("continue");
          return { type: "continue", state };
        case "completed":
          await this.conversation.emit({
            type: "agent_completed",
            source: "agent",
            result: completion.result,
          });
          await complete("completed");
          return { type: "completed", state, result: completion.result };
        case "suspended":
          return { type: "suspended", state };
        case "interrupted":
          await complete("interrupted");
          return { type: "interrupted", state };
      }
    }

    try {
      const outcome = await this.toolCallHandler.handleCalls({
        calls: response.toolCalls,
        trace,
        signal,
      });
      if (outcome.type === "suspended") return { type: "suspended", state };
      if (outcome.type === "interrupted") {
        await complete("interrupted");
        return { type: "interrupted", state };
      }
      await complete("continue");
      return { type: "continue", state };
    } catch (error) {
      const failure = await this.errorHandler.handle({
        source: "tool_call",
        error,
        trace,
        committedToolCalls: response.toolCalls,
      });
      await complete("error");
      return { type: "error", state, error: terminalMessage(failure) };
    }
  }

  private recordDiscarded(
    trace: ToolTrace,
    reason: "user_interrupt" | "agent_error"
  ) {
    return this.journal.append({
      type: "llm_disposition",
      runId: trace.runId,
      step: trace.step,
      llmCallId: trace.llmCallId,
      disposition: "discarded",
      reason,
      eventSeqs: [],
    });
  }
}

function terminalMessage(
  outcome: Awaited<ReturnType<AgentErrorHandler["handle"]>>
): string {
  return outcome.type === "error" ? outcome.message : "Agent 执行失败";
}
