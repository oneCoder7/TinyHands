import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { Agent } from "../agent.js";
import { Conversation } from "../../conversation/conversation.js";
import { projectCompactedContext } from "../../conversation/events.js";
import type { LLMClient } from "../../llm/llm-client.js";
import type { LLMResponse, Message } from "../../llm/types.js";
import { RunJournal, type RunLogRecord } from "../../observability/run-log.js";
import type { RunLogStore } from "../../observability/run-log-store.js";
import type { Runtime } from "../../runtime/runtime.js";
import { ToolRegistry, type Tool } from "../../tools/tool.js";
import { CompactionError } from "../context-compactor.js";

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

const REPORTED_USAGE = {
  status: "reported" as const,
  usage: { inputTokens: 15, outputTokens: 5, totalTokens: 20 },
};

const PROVIDER_REPLAY = {
  kind: "openai_responses" as const,
  version: 1 as const,
  scope: {
    provider: "openai" as const,
    apiMode: "responses" as const,
    model: "gpt-test",
    endpointHash: "hash",
  },
  items: [
    {
      type: "assistant_message" as const,
      content: "canonical",
    },
  ],
};

function response(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    stopReason: "tool_use",
    text: "",
    toolCalls: [{ id: "finish-1", name: "finish", args: { result: "secret-result" } }],
    usage: REPORTED_USAGE,
    ...overrides,
  };
}

const TEST_RUNTIME = {} as Runtime;

function conversation(): Conversation {
  return new Conversation("c1");
}

function runContext(signal?: AbortSignal) {
  return { runId: "run-1", runtime: TEST_RUNTIME, signal };
}

describe("Agent Run Log", () => {
  it("压缩失败只返回稳定 code，不生成包含底层错误的公开 error 事件", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(),
    };
    const conv = conversation();
    await conv.emit({ type: "user_message", source: "user", text: "go" });
    const compactor = {
      prepare: vi.fn(async () => {
        throw new CompactionError(
          "provider_error",
          "raw-provider-secret-response"
        );
      }),
    };

    const result = await new Agent(llm, new ToolRegistry(), {
      maxStep: 1,
      journal,
      compactor,
    }).run(conv, runContext());

    expect(result).toMatchObject({
      status: "error",
      error: "上下文压缩失败：provider_error",
    });
    expect(llm.chat).not.toHaveBeenCalled();
    expect(JSON.stringify(conv.getPublicEvents())).not.toContain(
      "raw-provider-secret-response"
    );
    expect(conv.getEvents().map((event) => event.type)).toEqual([
      "user_message",
    ]);
  });

  it("绑定多个 trigger，并完整记录 LLM/Tool/event seq，且不复制正文", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const finishExecute = vi.fn(async () => {
      expect(store.records.at(-1)?.type).toBe("tool_started");
      return { content: "secret-result", isError: false };
    });
    const finish: Tool<{ result: string }> = {
      name: "finish",
      description: "finish",
      schema: z.object({ result: z.string() }),
      execute: finishExecute,
    };
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(async () => {
        expect(store.records.at(-1)?.type).toBe("llm_started");
        return response({
          providerReplay: PROVIDER_REPLAY,
          toolCalls: [
            {
              id: "finish-1",
              name: "finish",
              args: { result: "secret-result" },
            },
            {
              id: "other-1",
              name: "side_effect",
              args: { value: "secret-arg" },
            },
          ],
        });
      }),
    };
    const conv = conversation();
    await conv.emit({
      type: "user_message",
      source: "user",
      text: "first",
      triggerId: "trigger-1",
    });
    await conv.emit({
      type: "user_message",
      source: "user",
      text: "second",
      triggerId: "trigger-2",
    });

    const result = await new Agent(llm, new ToolRegistry().register(finish), {
      maxStep: 1,
      journal,
    }).run(conv, runContext());

    expect(result.status).toBe("completed");
    expect(finishExecute).toHaveBeenCalledOnce();
    expect(store.records.find((record) => record.type === "step_started")).toMatchObject({
      runId: "run-1",
      step: 0,
      projectedThroughSeq: 2,
      triggerIds: ["trigger-1", "trigger-2"],
    });
    expect(store.records.find((record) => record.type === "llm_completed")).toMatchObject({
      usageStatus: "reported",
      usage: REPORTED_USAGE.usage,
    });

    const toolCompleted = store.records.find(
      (record) => record.type === "tool_completed"
    );
    expect(toolCompleted).toMatchObject({ outcome: "success", toolCallId: "finish-1" });
    if (toolCompleted?.type !== "tool_completed") throw new Error("missing tool_completed");
    expect(conv.getEvents().find((event) => event.seq === toolCompleted.resultEventSeq)).toMatchObject({
      type: "tool_result",
      toolCallId: "finish-1",
    });
    expect(store.records.find((record) => record.type === "tool_skipped")).toMatchObject({
      toolCallId: "other-1",
      reason: "finish_called",
    });
    expect(JSON.stringify(store.records)).not.toContain("secret-result");
    expect(JSON.stringify(store.records)).not.toContain("secret-arg");
    expect(
      conv.getEvents().find((event) => event.type === "agent_message")
    ).toMatchObject({ providerReplay: PROVIDER_REPLAY });
  });

  it("provider 已返回后发生 interrupt：保留 usage，但丢弃响应事实", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const controller = new AbortController();
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(async () => {
        controller.abort();
        return response();
      }),
    };
    const conv = conversation();
    await conv.emit({
      type: "user_message",
      source: "user",
      text: "go",
      triggerId: "trigger-1",
    });

    const result = await new Agent(llm, new ToolRegistry(), {
      maxStep: 1,
      journal,
    }).run(conv, runContext(controller.signal));

    expect(result.status).toBe("interrupted");
    expect(store.records.find((record) => record.type === "llm_completed")).toMatchObject({
      usageStatus: "reported",
      usage: REPORTED_USAGE.usage,
    });
    expect(store.records.find((record) => record.type === "llm_disposition")).toMatchObject({
      outcome: "discarded",
      reason: "user_interrupt",
      eventSeqs: [],
    });
    expect(conv.getEvents().map((event) => event.type)).toEqual(["user_message"]);
  });

  it("LLM 请求被 interrupt 时记录 aborted，且不提交响应事实", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const controller = new AbortController();
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(async () => {
        controller.abort();
        throw new Error("request aborted");
      }),
    };
    const conv = conversation();
    await conv.emit({ type: "user_message", source: "user", text: "go" });

    const result = await new Agent(llm, new ToolRegistry(), {
      maxStep: 1,
      journal,
    }).run(conv, runContext(controller.signal));

    expect(result.status).toBe("interrupted");
    expect(store.records.find((record) => record.type === "llm_failed")).toMatchObject({
      outcome: "aborted",
      errorCode: "llm_aborted",
    });
    expect(store.records.find((record) => record.type === "step_completed")).toMatchObject({
      outcome: "interrupted",
    });
    expect(conv.getEvents().map((event) => event.type)).toEqual(["user_message"]);
  });

  it("provider 失败只写 llm_failed，不伪造 completed usage", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(async () => {
        throw new Error("provider down");
      }),
    };
    const conv = conversation();
    await conv.emit({ type: "user_message", source: "user", text: "go" });

    await expect(
      new Agent(llm, new ToolRegistry(), { maxStep: 1, journal }).run(
        conv,
        runContext()
      )
    ).rejects.toThrow("provider down");

    expect(store.records.find((record) => record.type === "llm_failed")).toMatchObject({
      outcome: "provider_error",
      errorCode: "llm_provider_error",
    });
    expect(store.records.some((record) => record.type === "llm_completed")).toBe(false);
    expect(store.records.find((record) => record.type === "step_completed")).toMatchObject({
      outcome: "error",
    });
  });

  it("max_tokens 仍保留 usage，并把响应标记为 rejected", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(async () =>
        response({
          stopReason: "max_tokens",
          toolCalls: [],
          text: "partial",
          thinkingBlocks: [{ thinking: "untrusted", signature: "sig" }],
          providerReplay: PROVIDER_REPLAY,
        })
      ),
    };
    const conv = conversation();
    await conv.emit({ type: "user_message", source: "user", text: "go" });

    const result = await new Agent(llm, new ToolRegistry(), {
      maxStep: 1,
      journal,
    }).run(conv, runContext());

    expect(result.status).toBe("error");
    expect(store.records.find((record) => record.type === "llm_completed")).toMatchObject({
      usageStatus: "reported",
      usage: REPORTED_USAGE.usage,
    });
    expect(store.records.find((record) => record.type === "llm_disposition")).toMatchObject({
      outcome: "rejected",
      reason: "max_tokens",
    });
    expect(conv.getEvents().map((event) => event.type)).toEqual([
      "user_message",
      "error",
    ]);
  });

  it.each([
    ["content_filter" as const, "LLM 输出被内容过滤，本轮未执行"],
    ["refusal" as const, "LLM 拒绝了本轮请求，本轮未执行"],
  ])("%s 不提交响应或执行工具", async (stopReason, errorMessage) => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const execute = vi.fn(async () => ({ content: "should-not-run", isError: false }));
    const tool: Tool<Record<string, never>> = {
      name: "side_effect",
      description: "side effect",
      schema: z.object({}),
      execute,
    };
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "responses" },
      chat: vi.fn(async () =>
        response({
          stopReason,
          text: "untrusted",
          toolCalls: [{ id: "call-1", name: "side_effect", args: {} }],
          providerReplay: PROVIDER_REPLAY,
        })
      ),
    };
    const conv = conversation();
    await conv.emit({ type: "user_message", source: "user", text: "go" });

    const result = await new Agent(llm, new ToolRegistry().register(tool), {
      maxStep: 1,
      journal,
    }).run(conv, runContext());

    expect(result).toMatchObject({ status: "error", error: errorMessage });
    expect(execute).not.toHaveBeenCalled();
    expect(conv.getEvents().map((event) => event.type)).toEqual([
      "user_message",
      "error",
    ]);
    expect(store.records.find((record) => record.type === "llm_disposition")).toMatchObject({
      outcome: "rejected",
      reason: stopReason,
    });
  });

  it("step 开始前已 interrupt 时不写 step 生命周期", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const controller = new AbortController();
    controller.abort();
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(),
    };
    const conv = conversation();
    await conv.emit({ type: "user_message", source: "user", text: "go" });

    const result = await new Agent(llm, new ToolRegistry(), {
      maxStep: 1,
      journal,
    }).run(conv, runContext(controller.signal));

    expect(result.status).toBe("interrupted");
    expect(llm.chat).not.toHaveBeenCalled();
    expect(store.records.some((record) => record.type === "step_started")).toBe(
      false
    );
    expect(store.records.some((record) => record.type === "step_completed")).toBe(
      false
    );
  });

  it("可信响应先提交 thinking，再提交 agent_message", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const finish: Tool<{ result: string }> = {
      name: "finish",
      description: "finish",
      schema: z.object({ result: z.string() }),
      execute: vi.fn(async ({ result }) => ({ content: result, isError: false })),
    };
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(async () =>
        response({
          thinkingBlocks: [{ thinking: "reason", signature: "sig" }],
          toolCalls: [
            { id: "finish-1", name: "finish", args: { result: "done" } },
          ],
        })
      ),
    };
    const conv = conversation();
    await conv.emit({ type: "user_message", source: "user", text: "go" });

    const result = await new Agent(llm, new ToolRegistry().register(finish), {
      maxStep: 1,
      journal,
    }).run(conv, runContext());

    expect(result.status).toBe("completed");
    expect(conv.getEvents().map((event) => event.type)).toEqual([
      "user_message",
      "thinking_finished",
      "agent_message",
      "tool_result",
      "finished",
    ]);
  });

  it("finish 参数失败时提示重试，下一 step 可正常完成", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const finishExecute = vi.fn(async ({ result }: { result: string }) => ({
      content: result,
      isError: false,
    }));
    const finish: Tool<{ result: string }> = {
      name: "finish",
      description: "finish",
      schema: z.object({ result: z.string() }),
      execute: finishExecute,
    };
    let callCount = 0;
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(async () => {
        callCount++;
        return response({
          toolCalls: [
            {
              id: `finish-${callCount}`,
              name: "finish",
              args: { result: callCount === 1 ? 42 : "done" },
            },
          ],
        });
      }),
    };
    const conv = conversation();
    await conv.emit({ type: "user_message", source: "user", text: "go" });

    const result = await new Agent(llm, new ToolRegistry().register(finish), {
      maxStep: 2,
      journal,
    }).run(conv, runContext());

    expect(result).toMatchObject({ status: "completed", result: "done" });
    expect(finishExecute).toHaveBeenCalledOnce();
    expect(
      conv
        .getEvents()
        .filter((event) => event.type === "tool_result")
        .map((event) => event.isError)
    ).toEqual([true, false]);
    expect(
      conv
        .getEvents()
        .find(
          (event) =>
            event.type === "user_message" &&
            event.text.includes("finish 调用的参数有误")
        )
    ).toBeDefined();
    expect(
      store.records
        .filter((record) => record.type === "step_completed")
        .map((record) => record.outcome)
    ).toEqual(["continue", "finished"]);
  });

  it("无工具响应写入 finish 提示并继续下一 step", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const finish: Tool<{ result: string }> = {
      name: "finish",
      description: "finish",
      schema: z.object({ result: z.string() }),
      execute: vi.fn(async ({ result }) => ({ content: result, isError: false })),
    };
    let callCount = 0;
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return response({ stopReason: "end_turn", text: "先汇报", toolCalls: [] });
        }
        return response({
          toolCalls: [
            { id: "finish-2", name: "finish", args: { result: "done" } },
          ],
        });
      }),
    };
    const conv = conversation();
    await conv.emit({ type: "user_message", source: "user", text: "go" });

    const result = await new Agent(llm, new ToolRegistry().register(finish), {
      maxStep: 2,
      journal,
    }).run(conv, runContext());

    expect(result.status).toBe("completed");
    expect(llm.chat).toHaveBeenCalledTimes(2);
    expect(
      conv
        .getEvents()
        .find(
          (event) =>
            event.type === "user_message" && event.text.includes("请调用 finish 工具")
        )
    ).toBeDefined();
  });

  it("工具批次中途 interrupt 时补齐剩余 tool_result", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const controller = new AbortController();
    const firstExecute = vi.fn(async () => {
      controller.abort();
      return { content: "first-done", isError: false };
    });
    const secondExecute = vi.fn(async () => ({
      content: "second-done",
      isError: false,
    }));
    const first: Tool<Record<string, never>> = {
      name: "first",
      description: "first",
      schema: z.object({}),
      execute: firstExecute,
    };
    const second: Tool<Record<string, never>> = {
      name: "second",
      description: "second",
      schema: z.object({}),
      execute: secondExecute,
    };
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(async () =>
        response({
          toolCalls: [
            { id: "call-1", name: "first", args: {} },
            { id: "call-2", name: "second", args: {} },
          ],
        })
      ),
    };
    const conv = conversation();
    await conv.emit({ type: "user_message", source: "user", text: "go" });

    const result = await new Agent(
      llm,
      new ToolRegistry().register(first).register(second),
      { maxStep: 1, journal }
    ).run(conv, runContext(controller.signal));

    expect(result.status).toBe("interrupted");
    expect(firstExecute).toHaveBeenCalledOnce();
    expect(secondExecute).not.toHaveBeenCalled();
    expect(
      conv
        .getEvents()
        .filter((event) => event.type === "tool_result")
        .map((event) => ({ id: event.toolCallId, isError: event.isError }))
    ).toEqual([
      { id: "call-1", isError: false },
      { id: "call-2", isError: true },
    ]);
    expect(store.records.find((record) => record.type === "tool_skipped")).toMatchObject({
      toolCallId: "call-2",
      reason: "user_interrupt",
    });
  });

  it("最后一步最后一个工具期间 interrupt 不误报 max steps", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const controller = new AbortController();
    const tool: Tool<Record<string, never>> = {
      name: "only",
      description: "only",
      schema: z.object({}),
      execute: vi.fn(async () => {
        controller.abort();
        return { content: "done", isError: false };
      }),
    };
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(async () =>
        response({
          toolCalls: [{ id: "call-1", name: "only", args: {} }],
        })
      ),
    };
    const conv = conversation();
    await conv.emit({ type: "user_message", source: "user", text: "go" });

    const result = await new Agent(llm, new ToolRegistry().register(tool), {
      maxStep: 1,
      journal,
    }).run(conv, runContext(controller.signal));

    expect(result.status).toBe("interrupted");
    expect(conv.getEvents().some((event) => event.type === "error")).toBe(false);
    expect(store.records.find((record) => record.type === "step_completed")).toMatchObject({
      outcome: "interrupted",
    });
  });

  it("Compactor 与 trigger 归因使用同一事件快照", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const finish: Tool<{ result: string }> = {
      name: "finish",
      description: "finish",
      schema: z.object({ result: z.string() }),
      execute: vi.fn(async ({ result }) => ({ content: result, isError: false })),
    };
    const conv = conversation();
    await conv.emit({
      type: "user_message",
      source: "user",
      text: "first",
      triggerId: "trigger-1",
    });
    const compactor = {
      prepare: vi.fn(async (_conversation, events) => {
        await conv.emit({
          type: "user_message",
          source: "user",
          text: "late",
          triggerId: "trigger-late",
        });
        return {
          ...projectCompactedContext(events),
          projectedThroughSeq: events.at(-1)?.seq ?? 0,
          estimatedInputTokens: 0,
          compacted: false,
        };
      }),
    };
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(async (messages: Message[]) => {
        expect(messages.map((message) => message.text)).toEqual(["first"]);
        return response({
          toolCalls: [
            { id: "finish-1", name: "finish", args: { result: "done" } },
          ],
        });
      }),
    };

    const result = await new Agent(llm, new ToolRegistry().register(finish), {
      maxStep: 1,
      journal,
      compactor,
    }).run(conv, runContext());

    expect(result).toMatchObject({ status: "completed", projectedThroughSeq: 1 });
    expect(store.records.find((record) => record.type === "step_started")).toMatchObject({
      projectedThroughSeq: 1,
      triggerIds: ["trigger-1"],
    });
    expect(
      conv
        .getEvents()
        .find(
          (event) =>
            event.type === "user_message" && event.triggerId === "trigger-late"
        )
    ).toBeDefined();
  });
});
