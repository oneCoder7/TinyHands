import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startServer } from "../server.js";
import {
  createTinyhandsHost,
  type EventSubscription,
  type TinyhandsHostOptions,
} from "@tinyhands/server";
import type { PublicStreamItem } from "@tinyhands/protocol";

describe("standalone /v1 bridge", () => {
  it("内部 Fastify 同时承载 /v1 和 legacy，二者复用同一个 Host", async () => {
    const root = mkdtempSync(join(tmpdir(), "tinyhands-v1-test-"));
    const host = await createTinyhandsHost(config(root));
    const server = await startServer({ port: 0, host });
    try {
      const created = await server.inject({
        method: "POST",
        url: "/v1/conversations",
        payload: { conversationId: "c1", tools: [] },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ conversationId: "c1", running: false });

      const listed = await server.inject({ method: "GET", url: "/v1/conversations" });
      expect(listed.json()).toEqual({
        conversations: [
          expect.objectContaining({ conversationId: "c1", running: false }),
        ],
      });

      const legacy = await server.inject({
        method: "POST",
        url: "/conversations/list",
      });
      expect(legacy.json().conversations[0]).toMatchObject({ conversationId: "c1" });
    } finally {
      await Promise.all([server.close(), host.close()]);
    }
  });

  it("内部 Fetch bridge 以流式响应透传 /v1 SSE", async () => {
    const event: PublicStreamItem = {
      id: "evt-1",
      seq: 1,
      timestamp: 1,
      source: "user",
      type: "user_message",
      text: "bridge",
    };
    const stream: EventSubscription = {
      closeReason: "observer_closed",
      async close() {},
      async *[Symbol.asyncIterator]() {
        yield event;
      },
    };
    const host = {
      conversations: {
        events: async () => stream,
      },
      close: async () => {},
    } as never;
    const server = await startServer({ port: 0, host });
    try {
      const address = server.server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/conversations/c1/events`
      );
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(await response.text()).toContain('"text":"bridge"');
    } finally {
      await server.close();
    }
  });
});

function config(workspaceRoot: string): TinyhandsHostOptions {
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
