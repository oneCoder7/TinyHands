import { describe, expect, it } from "vitest";
import { readStandaloneConfig } from "../config.js";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    LLM_MODEL: "anthropic/claude-test",
    LLM_API_KEY: "shared-key",
    ...overrides,
  };
}

describe("standalone 配置", () => {
  it("按第一个斜杠拆 provider 与模型，并解析官方默认 endpoint", () => {
    expect(readStandaloneConfig(env()).host.llm).toMatchObject({
      provider: "anthropic",
      model: "claude-test",
      apiKey: "shared-key",
      baseURL: "https://api.anthropic.com",
      maxTokens: 8192,
      thinkingBudget: 2048,
      autoCompact: {
        enabled: true,
        contextWindow: 20_000,
        triggerRatio: 0.8,
        targetRatio: 0.5,
      },
    });

    expect(
      readStandaloneConfig(
        env({
          LLM_MODEL: "openai/Qwen/Qwen3-Coder",
          LLM_OPENAI_API_MODE: "chat_completions",
          LLM_BASE_URL: "https://gateway.example.com/v1",
        })
      ).host.llm
    ).toMatchObject({
      provider: "openai",
      model: "Qwen/Qwen3-Coder",
      baseURL: "https://gateway.example.com/v1",
      apiMode: "chat_completions",
    });
  });

  it("只生成当前 runtime 所需配置", () => {
    expect(readStandaloneConfig(env()).host.runtime).toEqual({ type: "local" });
    expect(
      readStandaloneConfig(env({ RUNTIME: "docker", DOCKER_IMAGE: "sandbox:v1" }))
        .host.runtime
    ).toEqual({ type: "docker", image: "sandbox:v1" });
    expect(
      readStandaloneConfig(
        env({
          RUNTIME: "opensandbox",
          OPENSANDBOX_SERVER_URL: "https://sandbox.example.com",
          OPENSANDBOX_API_KEY: "sandbox-key",
          OPENSANDBOX_IMAGE: "code:v1",
        })
      ).host.runtime
    ).toEqual({
      type: "opensandbox",
      serverUrl: "https://sandbox.example.com",
      apiKey: "sandbox-key",
      image: "code:v1",
    });
  });

  it("auto-compact 支持外部覆盖并严格校验预算", () => {
    expect(
      readStandaloneConfig(
        env({
          LLM_AUTO_COMPACT_ENABLED: "false",
          LLM_CONTEXT_WINDOW: "32000",
          LLM_AUTO_COMPACT_TRIGGER_RATIO: "0.75",
          LLM_AUTO_COMPACT_TARGET_RATIO: "0.4",
        })
      ).host.llm.autoCompact
    ).toEqual({
      enabled: false,
      contextWindow: 32_000,
      triggerRatio: 0.75,
      targetRatio: 0.4,
    });

    expect(() =>
      readStandaloneConfig(env({ LLM_AUTO_COMPACT_ENABLED: "yes" }))
    ).toThrow("LLM_AUTO_COMPACT_ENABLED");
    expect(() =>
      readStandaloneConfig(
        env({
          LLM_AUTO_COMPACT_TRIGGER_RATIO: "0.5",
          LLM_AUTO_COMPACT_TARGET_RATIO: "0.5",
        })
      )
    ).toThrow("TARGET_RATIO");
    expect(() =>
      readStandaloneConfig(env({ LLM_CONTEXT_WINDOW: "9000" }))
    ).toThrow("安全余量");
  });

  it("OpenAI 默认 responses，专属 key 优先但不跨 provider 借用", () => {
    expect(
      readStandaloneConfig(
        env({
          LLM_MODEL: "openai/gpt-test",
          OPENAI_API_KEY: "openai-key",
          ANTHROPIC_AUTH_TOKEN: "wrong-provider-key",
        })
      ).host.llm
    ).toMatchObject({
      provider: "openai",
      model: "gpt-test",
      apiKey: "openai-key",
      apiMode: "responses",
      baseURL: "https://api.openai.com/v1",
    });

    expect(() =>
      readStandaloneConfig({
        LLM_MODEL: "openai/gpt-test",
        ANTHROPIC_AUTH_TOKEN: "anthropic-only",
      })
    ).toThrow("缺少 openai API key");
  });

  it.each([
    [{ LLM_MODEL: "gpt-test" }, "provider/model"],
    [{ LLM_MODEL: "unknown/model" }, "未知的 LLM provider"],
    [
      { LLM_MODEL: "openai/gpt-test", LLM_OPENAI_API_MODE: "auto" },
      "未知的 LLM_OPENAI_API_MODE",
    ],
    [{ LLM_MAX_TOKENS: "0" }, "LLM_MAX_TOKENS"],
    [{ LLM_BASE_URL: "file:///tmp/gateway" }, "只支持 http/https"],
  ])("非法配置 fail fast：%o", (overrides, message) => {
    expect(() => readStandaloneConfig(env(overrides))).toThrow(message);
  });
});
