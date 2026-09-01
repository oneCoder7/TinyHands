import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { createTestConversation } from "../../conversation/__tests__/conversation-fixture.js";
import type { Conversation } from "../../conversation/conversation.js";
import type { LLMClient } from "../../llm/llm-client.js";
import { LLMRequestError } from "../../llm/llm-request-error.js";
import type { LLMResponse } from "../../llm/types.js";
import { RunJournal, type RunLogRecord } from "../../observability/run-log.js";
import type { RunLogStore } from "../../observability/run-log-store.js";
import type { Runtime } from "../../runtime/runtime.js";
import { ToolRegistry, type Tool } from "../../tools/tool.js";
import { createAgent } from "../create-agent.js";
import type { ContextPreparation } from "../context/context-preparation.js";
import {
  assertUniqueResponseValidatorIds,
  validateResponse,
} from "../step/response-validator.js";

class MemoryRunLogStore implements RunLogStore {
  records: RunLogRecord[] = [];
  async loadAndRepair(): Promise<RunLogRecord[]> { return [...this.records]; }
  async append(_conversationId: string, record: RunLogRecord): Promise<void> {
    this.records.push(record);
  }
  async remove(): Promise<void> {}
}

const usage = {
  status: "reported" as const,
  usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
};

function response(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return { stopReason: "end_turn", text: "", toolCalls: [], usage, ...overrides };
}

async function harness(options: {
  llm: LLMClient;
  conversation?: Conversation;
  tools?: ToolRegistry;
  contextPreparation?: ContextPreparation;
  responseValidators?: Parameters<typeof createAgent>[0]["responseValidators"];
  maxAttempts?: number;
}) {
  const conversation = options.conversation ?? createTestConversation("c1");
  const store = new MemoryRunLogStore();
  const journal = await RunJournal.open(conversation.id, store);
  const agent = createAgent({
    conversation,
    runtime: {} as Runtime,
    llm: options.llm,
    tools: options.tools ?? new ToolRegistry(),
    journal,
    maxStep: 1,
    maxModelAttemptsPerStep: options.maxAttempts ?? 1,
    contextPreparation: options.contextPreparation,
    responseValidators: options.responseValidators,
  }).agent;
  return { agent, conversation, store };
}

describe("Response Validator", () => {
  it("按注册顺序返回第一个 rejection，并拒绝重复 ID", async () => {
    const first = { id: "first", async validate() { return undefined; } };
    const second = {
      id: "second",
      async validate() {
        return { reason: "refusal" as const, message: "rejected" };
      },
    };
    expect(await validateResponse([first, second], "refusal")).toEqual({
      reason: "refusal",
      message: "rejected",
    });
    expect(() => assertUniqueResponseValidatorIds([first, first])).toThrow(
      "Response Validator ID 重复：first"
    );
  });
});

describe("Agent Step handlers", () => {
  it("Context Preparation 异常由 AgentErrorHandler 稳定化并闭合 step", async () => {
    const llm: LLMClient = {
      identity: { provider: "test", model: "model", apiMode: "messages" },
      chat: vi.fn(),
    };
    const broken: ContextPreparation = {
      id: "broken",
      async prepare() { throw new Error("secret context failure"); },
    };
    const { agent, conversation, store } = await harness({
      llm,
      contextPreparation: broken,
    });
    await conversation.emit({ type: "user_message", source: "user", text: "go" });

    const result = await agent.run({ runId: "run-1" });

    expect(result).toMatchObject({ status: "error", error: "Agent 上下文准备失败" });
    expect(JSON.stringify(conversation.getPublicEvents())).not.toContain("secret");
    expect(store.records.at(-1)).toMatchObject({
      type: "step_completed",
      outcome: "error",
    });
  });

  it("Response Validator 异常会 discard 未提交响应并闭合 step", async () => {
    const execute = vi.fn(async () => ({ content: "should-not-run", isError: false }));
    const tool: Tool<Record<string, never>> = {
      name: "side_effect",
      description: "side effect",
      schema: z.object({}),
      execute,
    };
    const llm: LLMClient = {
      identity: { provider: "test", model: "model", apiMode: "messages" },
      chat: vi.fn(async () =>
        response({
          stopReason: "tool_call",
          toolCalls: [{ id: "call-1", name: "side_effect", args: {} }],
        })
      ),
    };
    const { agent, conversation, store } = await harness({
      llm,
      tools: new ToolRegistry().register(tool),
      responseValidators: [
        {
          id: "broken-validator",
          async validate() { throw new Error("validator secret"); },
        },
      ],
    });
    await conversation.emit({ type: "user_message", source: "user", text: "go" });

    const result = await agent.run({ runId: "run-1" });

    expect(result).toMatchObject({ status: "error", error: "Agent 响应处理失败" });
    expect(execute).not.toHaveBeenCalled();
    expect(store.records.find((record) => record.type === "llm_disposition")).toMatchObject({
      disposition: "discarded",
      reason: "agent_error",
      eventSeqs: [],
    });
    expect(store.records.at(-1)).toMatchObject({ type: "step_completed", outcome: "error" });
    expect(JSON.stringify(conversation.getPublicEvents())).not.toContain("validator secret");
  });

  it("达到最大尝试次数的模型错误仍由 AgentErrorHandler 收敛，不上抛原始异常", async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(
        new LLMRequestError({ code: "unavailable", retryable: true })
      )
      .mockRejectedValueOnce(
        new LLMRequestError({ code: "unavailable", retryable: true })
      );
    const llm: LLMClient = {
      identity: { provider: "test", model: "model", apiMode: "messages" },
      chat,
    };
    const { agent, conversation, store } = await harness({ llm, maxAttempts: 2 });
    await conversation.emit({ type: "user_message", source: "user", text: "go" });

    const result = await agent.run({ runId: "run-1" });

    expect(result).toMatchObject({
      status: "error",
      error: "模型请求失败：unavailable",
    });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(store.records.filter((record) => record.type === "llm_failed")).toHaveLength(2);
    expect(store.records.at(-1)).toMatchObject({ type: "step_completed", outcome: "error" });
  });

  it("CompletionHandler 之后发生异常时为已提交 ToolCall 补齐结果", async () => {
    const finish: Tool<{ result: string }> = {
      name: "finish",
      description: "finish",
      schema: z.object({ result: z.string() }),
      execute: vi.fn(async () => {
        throw new Error("tool secret");
      }),
    };
    const llm: LLMClient = {
      identity: { provider: "test", model: "model", apiMode: "messages" },
      chat: vi.fn(async () =>
        response({
          stopReason: "tool_call",
          toolCalls: [{ id: "finish-1", name: "finish", args: { result: "x" } }],
        })
      ),
    };
    const { agent, conversation } = await harness({
      llm,
      tools: new ToolRegistry().register(finish),
    });
    await conversation.emit({ type: "user_message", source: "user", text: "go" });

    await agent.run({ runId: "run-1" });

    expect(
      conversation.getEvents().find(
        (event) => event.type === "tool_result" && event.toolCallId === "finish-1"
      )
    ).toMatchObject({ isError: true });
  });
});
