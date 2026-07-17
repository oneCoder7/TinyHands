import { describe, expect, it } from "vitest";
import { createLLMClient } from "../factory.js";

const shared = {
  apiKey: "key",
  baseURL: "https://gateway.example.com/v1",
  model: "model-test",
  maxTokens: 100,
  autoCompact: {
    enabled: true,
    contextWindow: 20_000,
    triggerRatio: 0.8,
    targetRatio: 0.5,
  },
};

describe("createLLMClient", () => {
  it("按判别配置选择三个 adapter，并固定 identity", () => {
    expect(
      createLLMClient({
        ...shared,
        provider: "anthropic",
        thinkingBudget: 0,
      }).identity
    ).toEqual({ provider: "anthropic", model: "model-test", apiMode: "messages" });
    expect(
      createLLMClient({ ...shared, provider: "openai", apiMode: "responses" })
        .identity
    ).toEqual({ provider: "openai", model: "model-test", apiMode: "responses" });
    expect(
      createLLMClient({
        ...shared,
        provider: "openai",
        apiMode: "chat_completions",
      }).identity
    ).toEqual({
      provider: "openai",
      model: "model-test",
      apiMode: "chat_completions",
    });
  });

  it("运行时防御未知 provider", () => {
    expect(() =>
      createLLMClient({ ...shared, provider: "unknown" } as any)
    ).toThrow("未知的 LLM provider");
  });
});
