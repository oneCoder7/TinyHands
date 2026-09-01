import { randomUUID } from "node:crypto";
import type { AutoCompactConfig } from "../../server/options.js";
import type { LLMClient } from "../../llm/llm-client.js";
import type { Message } from "../../llm/types.js";
import type { RunJournal } from "../../observability/run-log.js";
import type { Tool } from "../../tools/tool.js";
import type { Conversation } from "../../conversation/conversation.js";
import {
  projectCompactedContext,
  projectActiveContextMessages,
  serializeCompactSummary,
  type Event,
} from "../../conversation/events.js";
import {
  calculateCompactionBudget,
  estimateCanonicalInputTokens,
  type CompactionBudget,
} from "./compaction-budget.js";
import { findSafeCompactionBoundaries } from "./compaction-boundary.js";
import {
  CompactionSummary,
  projectCompactionHistory,
  projectCompactionTail,
} from "./compaction-summary.js";
import {
  CompactionError,
  CompactionInterruptedError,
} from "./compaction-error.js";

export { CompactionError } from "./compaction-error.js";

export { calculateCompactionBudget, estimateCanonicalInputTokens } from "./compaction-budget.js";
export { findSafeCompactionBoundaries } from "./compaction-boundary.js";

export interface CompactionPreparation {
  messages: Message[];
  systemContext: string[];
}

export class ContextCompactor {
  private readonly budget: CompactionBudget;
  private readonly summary: CompactionSummary;

  constructor(
    private readonly llm: LLMClient,
    private readonly journal: RunJournal,
    private readonly config: AutoCompactConfig,
    maxOutputTokens: number,
    private readonly conversation: Conversation
  ) {
    this.budget = calculateCompactionBudget(config, maxOutputTokens);
    this.summary = new CompactionSummary(
      llm,
      journal,
      this.budget.summaryMaxTokens
    );
  }

  async prepare(
    events: Event[],
    tools: Tool[],
    options: { runId: string; step: number; signal?: AbortSignal }
  ): Promise<CompactionPreparation> {
    const projectedThroughSeq = events.at(-1)?.seq ?? 0;
    const current = projectCompactedContext(events);
    const estimatedInputTokens = this.estimateWithUsageBaseline(
      events,
      current.messages,
      current.systemContext,
      tools,
      projectedThroughSeq
    );
    const unchanged = (): CompactionPreparation => ({
      messages: current.messages,
      systemContext: current.systemContext,
    });

    if (!this.config.enabled || estimatedInputTokens < this.budget.triggerTokens) {
      return unchanged();
    }
    if (options.signal?.aborted) throw new CompactionInterruptedError();

    const compactionId = randomUUID();
    await this.conversation.emit({
      type: "compaction_started",
      source: "agent",
      compactionId,
      reason: "threshold",
      estimatedTokens: estimatedInputTokens,
      triggerTokens: this.budget.triggerTokens,
    });

    let checkpointCommitted = false;
    try {
      const baseThroughSeq = current.checkpoint?.throughSeq ?? 0;
      const protectedUserSeq = events
        .filter(
          (event) =>
            event.type === "user_message" && event.seq > baseThroughSeq
        )
        .at(-1)?.seq;
      if (!protectedUserSeq) {
        throw new CompactionError(
          "no_safe_boundary",
          "没有可保留的最新用户消息，无法安全压缩"
        );
      }

      const boundaries = findSafeCompactionBoundaries(
        events,
        baseThroughSeq,
        protectedUserSeq
      ).filter((throughSeq) =>
        projectCompactionHistory(
          events.filter(
            (event) =>
              event.seq > baseThroughSeq && event.seq <= throughSeq
          )
        ).length > 0
      );

      let boundaryIndex = boundaries.findIndex((throughSeq) => {
        const tail = projectCompactionTail(events, throughSeq);
        return (
          estimateCanonicalInputTokens(tail, [], tools) +
            this.budget.summaryMaxTokens <=
          this.budget.targetTokens
        );
      });
      if (boundaryIndex === -1) {
        const protectedTail = [
          ...projectCompactionHistory(
            events.filter((event) => event.seq >= protectedUserSeq)
          ),
          ...projectActiveContextMessages(events),
        ];
        const protectedEstimate = estimateCanonicalInputTokens(
          protectedTail,
          [],
          tools
        );
        throw new CompactionError(
          protectedEstimate > this.budget.usableInputBudget
            ? "single_segment_overflow"
            : "no_safe_boundary",
          protectedEstimate > this.budget.usableInputBudget
            ? "最新上下文段单独超过可用窗口"
            : "找不到可满足目标预算的闭合压缩边界"
        );
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const throughSeq = boundaries[boundaryIndex];
        if (throughSeq === undefined) {
          throw new CompactionError(
            "summary_too_large",
            "扩大压缩前缀后仍无法满足目标预算"
          );
        }
        const prefixMessages = projectCompactionHistory(
          events.filter(
            (event) =>
              event.seq > baseThroughSeq && event.seq <= throughSeq
          )
        );
        const generated = await this.summary.generate({
          messages: prefixMessages,
          previousSummary: current.checkpoint?.summary,
          compactionId,
          projectedThroughSeq,
          ...options,
        });

        if (options.signal?.aborted) {
          await this.appendDisposition({
            ...options,
            llmCallId: generated.llmCallId,
            compactionId,
            disposition: "discarded",
            reason: "user_interrupt",
            eventSeqs: [],
          });
          throw new CompactionInterruptedError();
        }

        const tailMessages = projectCompactionTail(events, throughSeq);
        const systemContext = [serializeCompactSummary(generated.summary)];
        const estimatedAfterTokens = estimateCanonicalInputTokens(
          tailMessages,
          systemContext,
          tools
        );
        if (estimatedAfterTokens > this.budget.targetTokens) {
          await this.appendDisposition({
            ...options,
            llmCallId: generated.llmCallId,
            compactionId,
            disposition: "discarded",
            reason: "summary_too_large",
            eventSeqs: [],
          });
          boundaryIndex++;
          continue;
        }

        let checkpoint;
        try {
          checkpoint = await this.conversation.emit({
            type: "compaction_completed",
            source: "agent",
            compactionId,
            throughSeq,
            ...(current.checkpoint
              ? { replacesCompactionSeq: current.checkpoint.seq }
              : {}),
            summaryVersion: 1,
            summary: generated.summary,
            provider: this.llm.identity.provider,
            model: this.llm.identity.model,
            estimatedBeforeTokens: estimatedInputTokens,
            estimatedAfterTokens,
          });
        } catch (error) {
          await this.appendDisposition({
            ...options,
            llmCallId: generated.llmCallId,
            compactionId,
            disposition: "discarded",
            reason: "persistence_error",
            eventSeqs: [],
          });
          throw new CompactionError(
            "persistence_error",
            `checkpoint 落盘失败：${errorMessage(error)}`
          );
        }
        checkpointCommitted = true;

        let dispositionError: unknown;
        try {
          await this.appendDisposition({
            ...options,
            llmCallId: generated.llmCallId,
            compactionId,
            disposition: "committed",
            eventSeqs: [checkpoint.seq],
          });
        } catch (error) {
          dispositionError = error;
        }

        if (dispositionError) {
          throw new CompactionError(
            "persistence_error",
            `checkpoint 已提交，但 Run Log disposition 落盘失败：${errorMessage(
              dispositionError
            )}`
          );
        }
        return {
          messages: tailMessages,
          systemContext,
        };
      }

      throw new CompactionError(
        "summary_too_large",
        "两次压缩后仍无法达到目标预算"
      );
    } catch (error) {
      if (checkpointCommitted) throw error;
      if (options.signal?.aborted || error instanceof CompactionInterruptedError) {
        await this.conversation.emit({
          type: "compaction_cancelled",
          source: "agent",
          compactionId,
          reason: "user_interrupt",
        });
        throw new CompactionInterruptedError();
      }
      const failure =
        error instanceof CompactionError
          ? error
          : new CompactionError("provider_error", errorMessage(error));
      try {
        await this.conversation.emit({
          type: "compaction_failed",
          source: "agent",
          compactionId,
          code: failure.code,
        });
      } catch (emitError) {
        throw new CompactionError(
          "persistence_error",
          `压缩失败事件落盘失败：${errorMessage(emitError)}`
        );
      }
      throw failure;
    }
  }

  private async appendDisposition(input: {
    runId: string;
    step: number;
    llmCallId: string;
    compactionId: string;
    disposition: "committed" | "discarded";
    reason?: "user_interrupt" | "invalid_summary" | "summary_too_large" | "persistence_error";
    eventSeqs: number[];
    signal?: AbortSignal;
  }): Promise<void> {
    const { signal: _signal, ...record } = input;
    try {
      await this.journal.append({ type: "llm_disposition", ...record });
    } catch (error) {
      throw new CompactionError(
        "persistence_error",
        `压缩 llm_disposition 落盘失败：${errorMessage(error)}`
      );
    }
  }

  private estimateWithUsageBaseline(
    events: Event[],
    messages: Message[],
    systemContext: string[],
    tools: Tool[],
    projectedThroughSeq: number
  ): number {
    const canonical = estimateCanonicalInputTokens(
      messages,
      systemContext,
      tools
    );
    const records = this.journal.getRecords();
    for (let i = records.length - 1; i >= 0; i--) {
      const completed = records[i];
      if (
        completed?.type !== "llm_completed" ||
        completed.purpose !== "agent" ||
        completed.usageStatus !== "reported" ||
        !completed.usage ||
        completed.provider !== this.llm.identity.provider ||
        completed.model !== this.llm.identity.model ||
        completed.apiMode !== this.llm.identity.apiMode
      ) {
        continue;
      }
      const started = records.find(
        (record) =>
          record.type === "llm_started" &&
          record.llmCallId === completed.llmCallId
      );
      if (
        !started ||
        started.type !== "llm_started" ||
        started.projectedThroughSeq > projectedThroughSeq ||
        events.some(
          (event) =>
            event.type === "compacted" &&
            event.seq > started.projectedThroughSeq
        )
      ) {
        continue;
      }
      const baseline = projectCompactedContext(
        events.filter((event) => event.seq <= started.projectedThroughSeq)
      );
      const baselineCanonical = estimateCanonicalInputTokens(
        baseline.messages,
        baseline.systemContext,
        tools
      );
      if (canonical < baselineCanonical) return canonical;
      return Math.max(
        canonical,
        completed.usage.inputTokens + canonical - baselineCanonical
      );
    }
    return canonical;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
