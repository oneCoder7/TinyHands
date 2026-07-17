import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTinyhandsHost } from "../tinyhands-host.js";
import type { TinyhandsHostOptions } from "../options.js";

function hostConfig(workspaceRoot: string): TinyhandsHostOptions {
  return {
    workspaceRoot,
    maxStep: 2,
    runtime: { type: "local" },
    llm: {
      provider: "openai",
      apiKey: "test-key",
      baseURL: "http://localhost:1/v1",
      model: "test-model",
      maxTokens: 1024,
      apiMode: "responses",
      autoCompact: {
        enabled: true,
        contextWindow: 20_000,
        triggerRatio: 0.8,
        targetRatio: 0.5,
      },
    },
  };
}

describe("TinyhandsHost", () => {
  it("显式配置即可嵌入，不监听端口；close 保留数据且幂等", async () => {
    const root = mkdtempSync(join(tmpdir(), "tinyhands-host-test-"));
    const host = await createTinyhandsHost(hostConfig(root));
    await host.conversations.create({ conversationId: "c1", tools: [] });

    await Promise.all([host.close(), host.close()]);

    expect(existsSync(join(root, "c1", "meta.json"))).toBe(true);
    await expect(host.conversations.send("c1", "after close")).rejects.toThrow(
      /已关闭|正在关闭/
    );
  });
});
