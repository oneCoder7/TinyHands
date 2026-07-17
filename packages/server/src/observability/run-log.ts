import { z } from "zod/v4";
import type { RunLogStore } from "./run-log-store.js";

const SafeInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PositiveSafeInt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const Duration = z.number().finite().nonnegative();
const NonEmptyString = z.string().min(1);

const base = {
  version: z.literal(1),
  seq: PositiveSafeInt,
  timestamp: SafeInt,
  conversationId: NonEmptyString,
};

const callIdentity = {
  provider: NonEmptyString,
  model: NonEmptyString,
  apiMode: NonEmptyString,
};

const usage = z.strictObject({
  inputTokens: SafeInt,
  outputTokens: SafeInt,
  totalTokens: SafeInt,
  cacheReadInputTokens: SafeInt.optional(),
  cacheCreationInputTokens: SafeInt.optional(),
  reasoningTokens: SafeInt.optional(),
});

/** Run Log 一行记录的运行时 schema，也是静态类型的唯一来源。 */
export const RunLogRecordSchema = z
  .discriminatedUnion("type", [
    z.strictObject({ ...base, type: z.literal("run_started"), runId: NonEmptyString }),
    z.strictObject({
      ...base,
      type: z.literal("step_started"),
      runId: NonEmptyString,
      step: SafeInt,
      projectedThroughSeq: SafeInt,
      triggerIds: z.array(NonEmptyString),
    }),
    z.strictObject({
      ...base,
      type: z.literal("step_completed"),
      runId: NonEmptyString,
      step: SafeInt,
      outcome: z.enum(["continue", "finished", "error", "interrupted"]),
      durationMs: Duration,
    }),
    z.strictObject({
      ...base,
      type: z.literal("run_completed"),
      runId: NonEmptyString,
      status: z.enum([
        "completed",
        "max_steps_exceeded",
        "error",
        "interrupted",
      ]),
      projectedThroughSeq: SafeInt,
      durationMs: Duration,
      errorCode: NonEmptyString.optional(),
    }),
    z.strictObject({
      ...base,
      type: z.literal("run_recovered"),
      runId: NonEmptyString,
      outcome: z.literal("process_crashed"),
    }),
    z.strictObject({
      ...base,
      ...callIdentity,
      type: z.literal("llm_started"),
      runId: NonEmptyString,
      step: SafeInt,
      llmCallId: NonEmptyString,
      purpose: z.enum(["agent", "compaction"]),
      projectedThroughSeq: SafeInt,
      compactionId: NonEmptyString.optional(),
    }),
    z.strictObject({
      ...base,
      ...callIdentity,
      type: z.literal("llm_completed"),
      runId: NonEmptyString,
      step: SafeInt,
      llmCallId: NonEmptyString,
      purpose: z.enum(["agent", "compaction"]),
      stopReason: NonEmptyString,
      durationMs: Duration,
      usageStatus: z.enum(["reported", "not_reported", "invalid"]),
      usage: usage.optional(),
      compactionId: NonEmptyString.optional(),
    }),
    z.strictObject({
      ...base,
      ...callIdentity,
      type: z.literal("llm_failed"),
      runId: NonEmptyString,
      step: SafeInt,
      llmCallId: NonEmptyString,
      purpose: z.enum(["agent", "compaction"]),
      outcome: z.enum(["provider_error", "aborted"]),
      durationMs: Duration,
      errorCode: NonEmptyString.optional(),
      compactionId: NonEmptyString.optional(),
    }),
    z.strictObject({
      ...base,
      type: z.literal("llm_disposition"),
      runId: NonEmptyString,
      step: SafeInt,
      llmCallId: NonEmptyString,
      compactionId: NonEmptyString.optional(),
      outcome: z.enum(["committed", "discarded", "rejected"]),
      reason: z
        .enum([
          "user_interrupt",
          "max_tokens",
          "content_filter",
          "refusal",
          "invalid_summary",
          "summary_too_large",
          "persistence_error",
        ])
        .optional(),
      eventSeqs: z.array(PositiveSafeInt),
    }),
    z.strictObject({
      ...base,
      type: z.literal("tool_started"),
      runId: NonEmptyString,
      step: SafeInt,
      llmCallId: NonEmptyString,
      toolCallId: NonEmptyString,
      tool: NonEmptyString,
    }),
    z.strictObject({
      ...base,
      type: z.literal("tool_completed"),
      runId: NonEmptyString,
      step: SafeInt,
      llmCallId: NonEmptyString,
      toolCallId: NonEmptyString,
      tool: NonEmptyString,
      outcome: z.enum(["success", "error"]),
      durationMs: Duration,
      resultEventSeq: PositiveSafeInt,
    }),
    z.strictObject({
      ...base,
      type: z.literal("tool_skipped"),
      runId: NonEmptyString,
      step: SafeInt,
      llmCallId: NonEmptyString,
      toolCallId: NonEmptyString,
      tool: NonEmptyString,
      reason: z.enum(["user_interrupt", "finish_called"]),
      resultEventSeq: PositiveSafeInt,
    }),
  ])
  .superRefine((record, ctx) => {
    if (
      (record.type === "llm_started" ||
        record.type === "llm_completed" ||
        record.type === "llm_failed") &&
      ((record.purpose === "compaction" && !record.compactionId) ||
        (record.purpose === "agent" && record.compactionId !== undefined))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "compaction LLM 记录必须携带 compactionId，agent 调用不得携带",
      });
    }
    if (record.type !== "llm_completed") return;
    const consistent =
      (record.usageStatus === "reported" && record.usage !== undefined) ||
      (record.usageStatus !== "reported" && record.usage === undefined);
    if (!consistent) {
      ctx.addIssue({
        code: "custom",
        message: "reported usageStatus 与 usage 必须同时出现",
      });
    }
    if (
      record.usage &&
      record.usage.totalTokens !==
        record.usage.inputTokens + record.usage.outputTokens
    ) {
      ctx.addIssue({ code: "custom", message: "totalTokens 必须等于 input + output" });
    }
    if (
      record.usage?.reasoningTokens !== undefined &&
      record.usage.reasoningTokens > record.usage.outputTokens
    ) {
      ctx.addIssue({ code: "custom", message: "reasoningTokens 不能超过 outputTokens" });
    }
    if (
      record.usage &&
      (record.usage.cacheReadInputTokens ?? 0) +
        (record.usage.cacheCreationInputTokens ?? 0) >
        record.usage.inputTokens
    ) {
      ctx.addIssue({ code: "custom", message: "cache input breakdown 不能超过 inputTokens" });
    }
  });

export type RunLogRecord = z.infer<typeof RunLogRecordSchema>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K & keyof T>
  : never;

export type RunLogDraft = DistributiveOmit<
  RunLogRecord,
  "version" | "seq" | "timestamp" | "conversationId"
>;

/**
 * 每个 conversation 一份内存 journal：串行分配 seq，先落盘再推进内存状态。
 * 单次失败不会污染 append chain，后续调用仍可重试。
 */
export class RunJournal {
  private appendChain: Promise<void> = Promise.resolve();
  private lastAttributedEventSeq = 0;

  private constructor(
    readonly conversationId: string,
    private readonly store: RunLogStore,
    private readonly records: RunLogRecord[]
  ) {
    for (const record of records) {
      if (record.type === "step_started") {
        this.lastAttributedEventSeq = Math.max(
          this.lastAttributedEventSeq,
          record.projectedThroughSeq
        );
      }
    }
  }

  static async open(
    conversationId: string,
    store: RunLogStore
  ): Promise<RunJournal> {
    const records = await store.loadAndRepair(conversationId);
    return new RunJournal(conversationId, store, records);
  }

  async append(draft: RunLogDraft): Promise<RunLogRecord> {
    const task = this.appendChain.then(async () => {
      const record = RunLogRecordSchema.parse({
        ...draft,
        version: 1,
        seq: this.records.length + 1,
        timestamp: Date.now(),
        conversationId: this.conversationId,
      });
      await this.store.append(this.conversationId, record);
      this.records.push(record);
      if (record.type === "step_started") {
        this.lastAttributedEventSeq = Math.max(
          this.lastAttributedEventSeq,
          record.projectedThroughSeq
        );
      }
      return record;
    });
    this.appendChain = task.then(() => {}, () => {});
    return task;
  }

  getRecords(): RunLogRecord[] {
    return [...this.records];
  }

  getLastAttributedEventSeq(): number {
    return this.lastAttributedEventSeq;
  }

  /** 进程重启时闭合未完成的 run；只补审计事实，不自动重启执行。 */
  async recoverOpenRuns(): Promise<void> {
    const open = new Set<string>();
    for (const record of this.records) {
      if (record.type === "run_started") open.add(record.runId);
      if (record.type === "run_completed" || record.type === "run_recovered") {
        open.delete(record.runId);
      }
    }
    for (const runId of open) {
      await this.append({ type: "run_recovered", runId, outcome: "process_crashed" });
    }
  }
}
