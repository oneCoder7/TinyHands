import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicClient, normalizeAnthropicUsage } from "../anthropic-client.js";

function usage(
  overrides: Partial<Anthropic.Usage> = {}
): Anthropic.Usage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 100,
    output_tokens: 20,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    ...overrides,
  };
}

describe("normalizeAnthropicUsage", () => {
  it("把 cache input 计入权威输入总数，reasoning 仅作 breakdown", () => {
    expect(
      normalizeAnthropicUsage(
        usage({
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 10,
          output_tokens_details: { thinking_tokens: 8 },
        })
      )
    ).toEqual({
      status: "reported",
      usage: {
        inputTokens: 140,
        outputTokens: 20,
        totalTokens: 160,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
        reasoningTokens: 8,
      },
    });
  });

  it("null breakdown 不伪造为 0 字段", () => {
    expect(normalizeAnthropicUsage(usage())).toEqual({
      status: "reported",
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });
  });

  it("缺失 usage 与非法 token 分开表示", () => {
    expect(normalizeAnthropicUsage(undefined)).toEqual({ status: "not_reported" });
    expect(normalizeAnthropicUsage(usage({ input_tokens: -1 }))).toEqual({
      status: "invalid",
    });
    expect(
      normalizeAnthropicUsage(
        usage({ output_tokens: 3, output_tokens_details: { thinking_tokens: 4 } })
      )
    ).toEqual({ status: "invalid" });
  });
});

describe("AnthropicClient per-call options", () => {
  it("systemContext 与 maxTokens 覆盖映射到 Messages 请求", async () => {
    const create = vi.fn(async (..._args: any[]) =>
      ({
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: usage(),
      }) as Anthropic.Message
    );
    const client = { messages: { create } } as unknown as Anthropic;
    const adapter = new AnthropicClient(
      {
        apiKey: "key",
        baseURL: "https://api.anthropic.com",
        model: "claude-test",
        maxTokens: 100,
        thinkingBudget: 0,
      },
      client
    );
    const controller = new AbortController();

    await adapter.chat([{ role: "user", text: "go" }], [], {
      systemContext: ["a", "b"],
      maxTokens: 42,
      signal: controller.signal,
    });

    expect(create.mock.calls[0]![0]).toMatchObject({
      model: "claude-test",
      max_tokens: 42,
      system: "a\n\nb",
    });
    expect(create.mock.calls[0]![1]).toEqual({ signal: controller.signal });
  });
});
