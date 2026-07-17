import { randomUUID } from "node:crypto";
import type { LLMClient } from "../llm/llm-client.js";
import type {
  Delta,
  LLMResponse,
  Message,
} from "../llm/types.js";
import type { RunJournal } from "../observability/run-log.js";
import type { Tool } from "../tools/tool.js";

export interface AgentLlmCallInput {
  runId: string;
  step: number;
  projectedThroughSeq: number;
  messages: Message[];
  systemContext: string[];
  tools: Tool[];
  signal?: AbortSignal;
  onDelta: (delta: Delta) => void;
}

export type AgentLlmCallOutcome =
  | {
      type: "completed";
      llmCallId: string;
      response: LLMResponse;
    }
  | {
      type: "aborted";
      llmCallId: string;
    }
  | {
      type: "provider_error";
      llmCallId: string;
      error: unknown;
    };

/** 记录并执行一次正常 Agent LLM 调用，不提交 Conversation 业务事件。 */
export class AgentLlmCall {
  constructor(
    private readonly llm: LLMClient,
    private readonly journal: RunJournal
  ) {}

  async execute(input: AgentLlmCallInput): Promise<AgentLlmCallOutcome> {
    const llmCallId = randomUUID();
    await this.journal.append({
      type: "llm_started",
      runId: input.runId,
      step: input.step,
      llmCallId,
      purpose: "agent",
      projectedThroughSeq: input.projectedThroughSeq,
      ...this.llm.identity,
    });
    const startedAt = Date.now();

    let response: LLMResponse;
    try {
      response = await this.llm.chat(input.messages, input.tools, {
        onDelta: input.onDelta,
        signal: input.signal,
        systemContext: input.systemContext,
      });
    } catch (error) {
      const aborted = input.signal?.aborted === true;
      await this.journal.append({
        type: "llm_failed",
        runId: input.runId,
        step: input.step,
        llmCallId,
        purpose: "agent",
        outcome: aborted ? "aborted" : "provider_error",
        durationMs: Date.now() - startedAt,
        errorCode: aborted ? "llm_aborted" : "llm_provider_error",
        ...this.llm.identity,
      });
      if (aborted) return { type: "aborted", llmCallId };
      return { type: "provider_error", llmCallId, error };
    }

    await this.journal.append({
      type: "llm_completed",
      runId: input.runId,
      step: input.step,
      llmCallId,
      purpose: "agent",
      stopReason: response.stopReason,
      durationMs: Date.now() - startedAt,
      usageStatus: response.usage.status,
      ...(response.usage.status === "reported"
        ? { usage: response.usage.usage }
        : {}),
      ...this.llm.identity,
    });
    return { type: "completed", llmCallId, response };
  }
}
