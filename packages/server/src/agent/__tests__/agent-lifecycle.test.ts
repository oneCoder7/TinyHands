import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { Conversation } from "../../conversation/conversation.js";
import type { LLMClient } from "../../llm/llm-client.js";
import type { LLMResponse } from "../../llm/types.js";
import { RunJournal, type RunLogRecord } from "../../observability/run-log.js";
import type { RunLogStore } from "../../observability/run-log-store.js";
import type { Runtime } from "../../runtime/runtime.js";
import { ToolRegistry, type Tool } from "../../tools/tool.js";
import { Agent } from "../agent.js";
import {
  AgentLifecycle,
  AgentLifecycleError,
  createBuiltInAgentLifecycle,
  type ContextPreparation,
} from "../agent-lifecycle.js";

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

const USAGE = {
  status: "reported" as const,
  usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
};

function response(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    stopReason: "tool_call",
    text: "",
    toolCalls: [],
    usage: USAGE,
    ...overrides,
  };
}

function provider(id: string, text = id): ContextPreparation {
  return {
    id,
    async prepare() {
      return { messages: [{ role: "user", text }], systemContext: [] };
    },
  };
}

async function journalHarness() {
  const store = new MemoryRunLogStore();
  return {
    store,
    journal: await RunJournal.open("c1", store),
  };
}

describe("AgentLifecycle 组合语义", () => {
  it("拒绝跨阶段重复 ID", () => {
    expect(
      () =>
        new AgentLifecycle({
          contextPreparation: provider("duplicate"),
          responseValidators: [
            { id: "duplicate", async validate() { return undefined; } },
          ],
        })
    ).toThrow("Agent 生命周期组件 ID 重复：duplicate");
  });

  it("Request Error 按注册顺序取第一个明确决定", async () => {
    const calls: string[] = [];
    const lifecycle = new AgentLifecycle({
      contextPreparation: provider("context"),
      requestErrorResolvers: [
        {
          id: "r1",
          async resolve() {
            calls.push("r1");
            return undefined;
          },
        },
        {
          id: "r2",
          async resolve() {
            calls.push("r2");
            return "retry";
          },
        },
        {
          id: "r3",
          async resolve() {
            calls.push("r3");
            return "fail";
          },
        },
      ],
    });

    await expect(
      lifecycle.resolveRequestError({ error: new Error("down"), attempt: 1 })
    ).resolves.toBe("retry");
    expect(calls).toEqual(["r1", "r2"]);
  });

  it("Response Validator 全部通过，第一个拒绝时停止", async () => {
    const calls: string[] = [];
    const lifecycle = new AgentLifecycle({
      contextPreparation: provider("context"),
      responseValidators: [
        {
          id: "v1",
          async validate() {
            calls.push("v1");
            return undefined;
          },
        },
        {
          id: "v2",
          async validate() {
            calls.push("v2");
            return { reason: "refusal", message: "rejected" };
          },
        },
        {
          id: "v3",
          async validate() {
            calls.push("v3");
            return undefined;
          },
        },
      ],
    });

    await expect(lifecycle.inspectResponse("refusal")).resolves.toEqual({
      reason: "refusal",
      message: "rejected",
    });
    expect(calls).toEqual(["v1", "v2"]);
  });

  it("Committed Response 按注册顺序取第一个计划", async () => {
    const calls: string[] = [];
    const lifecycle = new AgentLifecycle({
      contextPreparation: provider("context"),
      committedResponsePolicies: [
        {
          id: "p1",
          async plan() {
            calls.push("p1");
            return undefined;
          },
        },
        {
          id: "p2",
          async plan() {
            calls.push("p2");
            return { type: "continue", contextMessage: "next" };
          },
        },
        {
          id: "p3",
          async plan() {
            calls.push("p3");
            return undefined;
          },
        },
      ],
    });

    await expect(lifecycle.planCommittedResponse([])).resolves.toEqual({
      type: "continue",
      contextMessage: "next",
    });
    expect(calls).toEqual(["p1", "p2"]);
  });

  it("每次装配持有独立组件实例", async () => {
    const makeLifecycle = () => {
      let count = 0;
      return new AgentLifecycle({
        contextPreparation: {
          id: "stateful-context",
          async prepare() {
            count++;
            return {
              messages: [{ role: "user", text: String(count) }],
              systemContext: [],
            };
          },
        },
      });
    };
    const first = makeLifecycle();
    const second = makeLifecycle();
    const input = { events: [], tools: [], runId: "run", step: 0 };

    expect((await first.prepareContext(input)).messages[0]?.text).toBe("1");
    expect((await first.prepareContext(input)).messages[0]?.text).toBe("2");
    expect((await second.prepareContext(input)).messages[0]?.text).toBe("1");
  });
});

describe("AgentStepExecutor 生命周期失败与重试", () => {
  it("Context Provider 异常进入稳定 error 并闭合 step", async () => {
    const { store, journal } = await journalHarness();
    const llm: LLMClient = {
      identity: { provider: "test", model: "model", apiMode: "messages" },
      chat: vi.fn(),
    };
    const lifecycle = new AgentLifecycle({
      contextPreparation: {
        id: "broken-context",
        async prepare() {
          throw new Error("secret context failure");
        },
      },
    });
    const conversation = new Conversation("c1");
    await conversation.emit({
      type: "user_message",
      source: "user",
      text: "go",
    });

    const result = await new Agent(llm, new ToolRegistry(), {
      maxStep: 1,
      journal,
      lifecycle,
    }).run(conversation, {
      runId: "run-1",
      runtime: {} as Runtime,
    });

    expect(result).toMatchObject({
      status: "error",
      error: "Agent 生命周期扩展失败：prepare_context",
    });
    expect(JSON.stringify(conversation.getPublicEvents())).not.toContain(
      "secret context failure"
    );
    expect(store.records.at(-1)).toMatchObject({
      type: "step_completed",
      outcome: "error",
    });
  });

  it("Response Validator 异常会 discard 响应且不执行工具", async () => {
    const { store, journal } = await journalHarness();
    const execute = vi.fn(async () => ({ content: "bad", isError: false }));
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
          toolCalls: [{ id: "call-1", name: "side_effect", args: {} }],
        })
      ),
    };
    const lifecycle = createBuiltInAgentLifecycle({
      responseValidators: [
        {
          id: "broken-validator",
          async validate() {
            throw new Error("secret validator failure");
          },
        },
      ],
    });
    const conversation = new Conversation("c1");
    await conversation.emit({ type: "user_message", source: "user", text: "go" });

    const result = await new Agent(llm, new ToolRegistry().register(tool), {
      maxStep: 1,
      journal,
      lifecycle,
    }).run(conversation, { runId: "run-1", runtime: {} as Runtime });

    expect(result.status).toBe("error");
    expect(execute).not.toHaveBeenCalled();
    expect(conversation.getEvents().some((event) => event.type === "agent_message"))
      .toBe(false);
    expect(store.records.find((record) => record.type === "llm_disposition"))
      .toMatchObject({ disposition: "discarded", reason: "lifecycle_error" });
  });

  it("Committed Response Policy 异常会为已提交 tool calls 补 skipped result", async () => {
    const { store, journal } = await journalHarness();
    const execute = vi.fn(async () => ({ content: "bad", isError: false }));
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
          toolCalls: [{ id: "call-1", name: "side_effect", args: {} }],
        })
      ),
    };
    const lifecycle = createBuiltInAgentLifecycle({
      committedResponsePolicies: [
        {
          id: "broken-policy",
          async plan() {
            throw new Error("secret policy failure");
          },
        },
      ],
    });
    const conversation = new Conversation("c1");
    await conversation.emit({ type: "user_message", source: "user", text: "go" });

    const result = await new Agent(llm, new ToolRegistry().register(tool), {
      maxStep: 1,
      journal,
      lifecycle,
    }).run(conversation, { runId: "run-1", runtime: {} as Runtime });

    expect(result.status).toBe("error");
    expect(execute).not.toHaveBeenCalled();
    expect(
      conversation.getEvents().find((event) => event.type === "tool_result")
    ).toMatchObject({ toolCallId: "call-1", isError: true });
    expect(store.records.find((record) => record.type === "tool_call_skipped"))
      .toMatchObject({ toolCallId: "call-1", reason: "lifecycle_error" });
  });

  it("Request Error Resolver 可在固定上限内重试", async () => {
    const { store, journal } = await journalHarness();
    const finish: Tool<{ result: string }> = {
      name: "finish",
      description: "finish",
      schema: z.object({ result: z.string() }),
      async execute({ result }) {
        return { content: result, isError: false };
      },
    };
    const chat = vi
      .fn<LLMClient["chat"]>()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(
        response({
          toolCalls: [
            { id: "finish-1", name: "finish", args: { result: "done" } },
          ],
        })
      );
    const resolver = vi.fn(async () => "retry" as const);
    const lifecycle = createBuiltInAgentLifecycle({
      requestErrorResolvers: [{ id: "retry-once", resolve: resolver }],
    });
    const llm: LLMClient = {
      identity: { provider: "test", model: "model", apiMode: "messages" },
      chat,
    };
    const conversation = new Conversation("c1");
    await conversation.emit({ type: "user_message", source: "user", text: "go" });

    const result = await new Agent(llm, new ToolRegistry().register(finish), {
      maxStep: 1,
      maxModelAttemptsPerStep: 2,
      journal,
      lifecycle,
    }).run(conversation, { runId: "run-1", runtime: {} as Runtime });

    expect(result).toMatchObject({ status: "completed", result: "done" });
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1 })
    );
    expect(
      store.records.filter((record) => record.type === "llm_started")
    ).toHaveLength(2);
  });

  it("生命周期组件异常统一包装为稳定错误", async () => {
    const lifecycle = new AgentLifecycle({
      contextPreparation: provider("context"),
      requestErrorResolvers: [
        {
          id: "broken-resolver",
          async resolve() {
            throw new Error("raw provider body");
          },
        },
      ],
    });
    await expect(
      lifecycle.resolveRequestError({ error: new Error("down"), attempt: 1 })
    ).rejects.toEqual(
      expect.objectContaining<Partial<AgentLifecycleError>>({
        name: "AgentLifecycleError",
        phase: "request_error",
        componentId: "broken-resolver",
      })
    );
  });
});
