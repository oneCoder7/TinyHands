import type { Conversation } from "../conversation/conversation.js";
import {
  projectCompactedContext,
  type Event,
} from "../conversation/events.js";
import type { LLMClient } from "../llm/llm-client.js";
import type { LLMResponse } from "../llm/types.js";
import type { RunJournal } from "../observability/run-log.js";
import type { Runtime } from "../runtime/runtime.js";
import type { ToolContext, ToolRegistry } from "../tools/tool.js";
import { AgentLlmCall } from "./agent-llm-call.js";
import {
  CompactionError,
  type ContextCompactorLike,
} from "./context-compactor.js";
import { ToolExecutor } from "./tool-executor.js";

export interface AgentRunState {
  lastText: string;
  projectedThroughSeq: number;
}

export type AgentStepOutcome =
  | { type: "continue"; state: AgentRunState }
  | { type: "completed"; state: AgentRunState; result: string }
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

interface AgentStepExecutorOptions {
  journal: RunJournal;
  compactor?: ContextCompactorLike;
}

/** 一个 ReAct step 的事务编排：固定快照、调用 LLM、提交响应并调度工具。 */
export class AgentStepExecutor {
  private readonly journal: RunJournal;
  private readonly compactor?: ContextCompactorLike;
  private readonly llmCall: AgentLlmCall;
  private readonly toolExecutor: ToolExecutor;

  constructor(
    llm: LLMClient,
    private readonly tools: ToolRegistry,
    options: AgentStepExecutorOptions
  ) {
    this.journal = options.journal;
    this.compactor = options.compactor;
    this.llmCall = new AgentLlmCall(llm, options.journal);
    this.toolExecutor = new ToolExecutor(tools, options.journal);
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
      outcome: "continue" | "finished" | "error" | "interrupted"
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

    let prepared = {
      ...projectCompactedContext(events),
      projectedThroughSeq,
      estimatedInputTokens: 0,
      compacted: false,
    };
    if (this.compactor) {
      try {
        prepared = await this.compactor.prepare(
          conversation,
          events,
          this.tools.list(),
          { runId, step, signal }
        );
      } catch (error) {
        if (signal?.aborted) {
          await completeStep("interrupted");
          return { type: "interrupted", state: state(previousState.lastText) };
        }
        await completeStep("error");
        if (error instanceof CompactionError) {
          return {
            type: "error",
            state: state(previousState.lastText),
            error: `上下文压缩失败：${error.code}`,
          };
        }
        throw error;
      }
    }
    projectedThroughSeq = prepared.projectedThroughSeq;
    if (signal?.aborted) {
      await completeStep("interrupted");
      return { type: "interrupted", state: state(previousState.lastText) };
    }

    const llmOutcome = await this.llmCall.execute({
      runId,
      step,
      projectedThroughSeq,
      messages: prepared.messages,
      systemContext: prepared.systemContext,
      tools: this.tools.list(),
      signal,
      onDelta: (delta) => conversation.emitDelta(delta),
    });
    if (llmOutcome.type === "provider_error") {
      await completeStep("error");
      throw llmOutcome.error;
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
        outcome: "discarded",
        reason: "user_interrupt",
        eventSeqs: [],
      });
      await completeStep("interrupted");
      return { type: "interrupted", state: state(previousState.lastText) };
    }

    const lastText = response.text;
    const responseEventSeqs: number[] = [];
    const rejection = rejectedResponse(response.stopReason);
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
        outcome: "rejected",
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
        type: "thinking_finished",
        source: "agent",
        blocks: response.thinkingBlocks,
      });
      responseEventSeqs.push(thinkingEvent.seq);
    }

    if (response.toolCalls.length === 0) {
      const agentEvent = await this.commitAgentMessage(conversation, response);
      responseEventSeqs.push(agentEvent.seq);
      await this.recordCommittedDisposition(
        runId,
        step,
        llmCallId,
        responseEventSeqs
      );
      await conversation.emit({
        type: "user_message",
        source: "user",
        text:
          "如果任务已经完成，请调用 finish 工具给出最终答复；" +
          "如果还需要继续操作，请发起相应的工具调用。",
      });
      await completeStep("continue");
      return { type: "continue", state: state(lastText) };
    }

    const agentEvent = await this.commitAgentMessage(conversation, response);
    responseEventSeqs.push(agentEvent.seq);
    await this.recordCommittedDisposition(
      runId,
      step,
      llmCallId,
      responseEventSeqs
    );

    const trace = { runId, step, llmCallId };
    const context: ToolContext = { runtime };
    const finishCall = response.toolCalls.find((call) => call.name === "finish");
    if (finishCall) {
      const result = await this.toolExecutor.execute(
        conversation,
        finishCall,
        context,
        trace
      );
      for (const call of response.toolCalls) {
        if (call.id === finishCall.id) continue;
        await this.toolExecutor.skip(
          conversation,
          call,
          trace,
          "finish_called",
          "finish 已在本轮调用，该工具未执行"
        );
      }

      if (result.isError) {
        await conversation.emit({
          type: "user_message",
          source: "user",
          text: "finish 调用的参数有误，请检查后重新调用 finish 工具。",
        });
        await completeStep("continue");
        return { type: "continue", state: state(lastText) };
      }

      await conversation.emit({
        type: "finished",
        source: "agent",
        result: result.content,
      });
      await completeStep("finished");
      return {
        type: "completed",
        state: state(lastText),
        result: result.content,
      };
    }

    const batchOutcome = await this.toolExecutor.executeBatch(
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

    await completeStep("continue");
    return { type: "continue", state: state(lastText) };
  }

  private commitAgentMessage(
    conversation: Conversation,
    response: LLMResponse
  ) {
    return conversation.emit({
      type: "agent_message",
      source: "agent",
      text: response.text,
      toolCalls: response.toolCalls,
      providerReplay: response.providerReplay,
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
      outcome: "committed",
      eventSeqs,
    });
  }
}

function rejectedResponse(
  stopReason: LLMResponse["stopReason"]
):
  | {
      reason: "max_tokens" | "content_filter" | "refusal";
      message: string;
    }
  | undefined {
  switch (stopReason) {
    case "max_tokens":
      return { reason: stopReason, message: "LLM 输出被截断，本轮结果不可信" };
    case "content_filter":
      return { reason: stopReason, message: "LLM 输出被内容过滤，本轮未执行" };
    case "refusal":
      return { reason: stopReason, message: "LLM 拒绝了本轮请求，本轮未执行" };
    default:
      return undefined;
  }
}
