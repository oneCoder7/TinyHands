import { describe, expect, it, vi } from "vitest";
import { ContextCompactor, findSafeCompactionBoundaries } from "../context-compactor.js";
import { Conversation } from "../../conversation/conversation.js";
import type { Event } from "../../conversation/events.js";
import type { LLMClient } from "../../llm/llm-client.js";
import type { LLMResponse } from "../../llm/types.js";
import { RunJournal, type RunLogRecord } from "../../observability/run-log.js";
import type { RunLogStore } from "../../observability/run-log-store.js";

class MemoryRunLogStore implements RunLogStore {
  records: RunLogRecord[] = [];
  async loadAndRepair(): Promise<RunLogRecord[]> {
    return [...this.records];
  }
  async append(_conversationId: string, record: RunLogRecord): Promise<void> {
    this.records.push(record);
  }
  async remove(): Promise<void> {}
}

const CONFIG = {
  enabled: true,
  contextWindow: 10_000,
  triggerRatio: 0.4,
  targetRatio: 0.3,
};

const SUMMARY = {
  objective: "keep working",
  confirmedDecisions: ["decision"],
  constraints: ["constraint"],
  completedWork: ["old work"],
  currentState: ["current"],
  importantArtifacts: [{ path: "/workspace/a.ts", purpose: "source" }],
  unresolvedIssues: ["issue"],
  nextActions: ["next"],
};

function response(text = JSON.stringify(SUMMARY)): LLMResponse {
  return {
    stopReason: "end_turn",
    text,
    toolCalls: [],
    usage: {
      status: "reported",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    },
  };
}

async function harness(
  chat: LLMClient["chat"] = vi.fn(async () => response())
) {
  const store = new MemoryRunLogStore();
  const journal = await RunJournal.open("c1", store);
  const llm: LLMClient = {
    identity: { provider: "test", model: "model", apiMode: "messages" },
    chat,
  };
  return {
    store,
    journal,
    llm,
    compactor: new ContextCompactor(llm, journal, CONFIG, 1000),
    conversation: new Conversation("c1"),
  };
}

describe("ContextCompactor", () => {
  it("低于阈值时不调用 LLM，也不产生生命周期事件", async () => {
    const h = await harness();
    await h.conversation.emit({
      type: "user_message",
      source: "user",
      text: "short",
    });

    const prepared = await h.compactor.prepare(
      h.conversation,
      h.conversation.getEvents(),
      [],
      { runId: "run-1", step: 0 }
    );

    expect(prepared.compacted).toBe(false);
    expect(h.llm.chat).not.toHaveBeenCalled();
    expect(h.conversation.getEvents().map((event) => event.type)).toEqual([
      "user_message",
    ]);
  });

  it("达到阈值后提交 checkpoint，保留最新 query，并完整记录压缩 LLM", async () => {
    const h = await harness();
    await h.conversation.emit({
      type: "user_message",
      source: "user",
      text: "old artifact /workspace/a.ts:" + "x".repeat(15_000),
    });
    await h.conversation.emit({
      type: "agent_message",
      source: "agent",
      text: "old answer",
      toolCalls: [],
    });
    const latest = await h.conversation.emit({
      type: "user_message",
      source: "user",
      text: "latest query",
    });

    const prepared = await h.compactor.prepare(
      h.conversation,
      h.conversation.getEvents(),
      [],
      { runId: "run-1", step: 0 }
    );

    expect(prepared.compacted).toBe(true);
    expect(prepared.messages).toContainEqual({ role: "user", text: "latest query" });
    expect(prepared.systemContext[0]).toContain('"objective":"keep working"');
    const events = h.conversation.getEvents();
    expect(events.map((event) => event.type)).toEqual([
      "user_message",
      "agent_message",
      "user_message",
      "compaction_started",
      "compacted",
      "compaction_completed",
    ]);
    const checkpoint = events.find(
      (event): event is Extract<Event, { type: "compacted" }> =>
        event.type === "compacted"
    );
    expect(checkpoint?.throughSeq).toBeLessThan(latest.seq);
    expect(h.conversation.getPublicEvents().map((event) => event.type)).not.toContain(
      "compacted"
    );
    expect(h.llm.chat).toHaveBeenCalledWith(
      expect.any(Array),
      [],
      expect.objectContaining({ maxTokens: expect.any(Number) })
    );
    expect(h.store.records.map((record) => record.type)).toEqual([
      "llm_started",
      "llm_completed",
      "llm_disposition",
    ]);
    expect(h.store.records[0]).toMatchObject({
      purpose: "compaction",
      compactionId: checkpoint?.compactionId,
    });
  });

  it("摘要连续无效时只修复一次，最终公开 summary_invalid", async () => {
    const chat = vi.fn(async () => response("not-json"));
    const h = await harness(chat);
    await h.conversation.emit({
      type: "user_message",
      source: "user",
      text: "old:" + "x".repeat(15_000),
    });
    await h.conversation.emit({
      type: "user_message",
      source: "user",
      text: "latest",
    });

    await expect(
      h.compactor.prepare(h.conversation, h.conversation.getEvents(), [], {
        runId: "run-1",
        step: 0,
      })
    ).rejects.toMatchObject({ code: "summary_invalid" });

    expect(chat).toHaveBeenCalledTimes(2);
    expect(h.conversation.getEvents().at(-1)).toMatchObject({
      type: "compaction_failed",
      code: "summary_invalid",
    });
    expect(h.conversation.getEvents().some((event) => event.type === "compacted"))
      .toBe(false);
  });

  it("摘要请求期间 interrupt 会 cancelled，且不提交 checkpoint", async () => {
    const chat = vi.fn(
      async (_messages, _tools, options) =>
        await new Promise<LLMResponse>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true }
          );
        })
    );
    const h = await harness(chat);
    await h.conversation.emit({
      type: "user_message",
      source: "user",
      text: "old:" + "x".repeat(15_000),
    });
    await h.conversation.emit({
      type: "user_message",
      source: "user",
      text: "latest",
    });
    const controller = new AbortController();
    const preparing = h.compactor.prepare(
      h.conversation,
      h.conversation.getEvents(),
      [],
      { runId: "run-1", step: 0, signal: controller.signal }
    );
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
    controller.abort();

    await expect(preparing).rejects.toThrow("中断");
    expect(h.conversation.getEvents().at(-1)).toMatchObject({
      type: "compaction_cancelled",
      reason: "user_interrupt",
    });
    expect(h.conversation.getEvents().some((event) => event.type === "compacted"))
      .toBe(false);
    expect(h.store.records.find((record) => record.type === "llm_failed"))
      .toMatchObject({ outcome: "aborted", purpose: "compaction" });
  });

  it("最新单段独自超过窗口时明确失败，不调用摘要模型", async () => {
    const h = await harness();
    await h.conversation.emit({
      type: "user_message",
      source: "user",
      text: "x".repeat(30_000),
    });

    await expect(
      h.compactor.prepare(h.conversation, h.conversation.getEvents(), [], {
        runId: "run-1",
        step: 0,
      })
    ).rejects.toMatchObject({ code: "single_segment_overflow" });
    expect(h.llm.chat).not.toHaveBeenCalled();
    expect(h.conversation.getEvents().at(-1)).toMatchObject({
      type: "compaction_failed",
      code: "single_segment_overflow",
    });
  });
});

describe("findSafeCompactionBoundaries", () => {
  it("不会在 thinking/工具调用未闭合处切割", () => {
    const events: Event[] = [
      { id: "e1", seq: 1, timestamp: 1, source: "user", type: "user_message", text: "old" },
      { id: "e2", seq: 2, timestamp: 2, source: "agent", type: "thinking_finished", blocks: [] },
      { id: "e3", seq: 3, timestamp: 3, source: "agent", type: "agent_message", text: "", toolCalls: [{ id: "t1", name: "tool", args: {} }] },
      { id: "e4", seq: 4, timestamp: 4, source: "environment", type: "tool_result", toolCallId: "t1", content: "ok", isError: false },
      { id: "e5", seq: 5, timestamp: 5, source: "user", type: "user_message", text: "latest" },
    ];
    expect(findSafeCompactionBoundaries(events, 0, 5)).toEqual([1, 4]);
  });
});
