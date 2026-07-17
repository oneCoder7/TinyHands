import { describe, expect, it, vi } from "vitest";
import type { PublicStreamItem } from "@tinyhands/protocol";
import {
  ConversationExistsError,
  type EventSubscription,
} from "../conversation-service.js";
import { createTinyhandsFetchHandler } from "../fetch-handler.js";

function subscription(
  items: PublicStreamItem[],
  closeReason: EventSubscription["closeReason"]
): EventSubscription {
  return {
    closeReason,
    async close() {},
    async *[Symbol.asyncIterator]() {
      yield* items;
    },
  };
}

function fakeHost(overrides: Record<string, unknown> = {}) {
  return {
    conversations: {
      create: vi.fn(async () => ({
        conversationId: "c1",
        createdAt: 10,
        running: false,
      })),
      list: vi.fn(async () => [
        {
          conversationId: "c1",
          createdAt: 10,
          running: false,
          eventCount: 3,
          resident: true,
        },
      ]),
      delete: vi.fn(async () => ({ deleted: true as const })),
      send: vi.fn(async () => ({
        accepted: true as const,
        running: true,
        triggerId: "trigger-1",
      })),
      interrupt: vi.fn(async () => ({ interrupted: true })),
      events: vi.fn(async () => subscription([], undefined)),
      ...overrides,
    },
    close: vi.fn(async () => {}),
  } as never;
}

describe("Tinyhands Fetch handler", () => {
  it("提供版本化 REST DTO，list 不泄露 resident/eventCount", async () => {
    const host = fakeHost();
    const handle = createTinyhandsFetchHandler({ host });

    const created = await handle(
      new Request("http://tinyhands.test/v1/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: "c1", tools: [] }),
      })
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      conversationId: "c1",
      createdAt: 10,
      running: false,
    });

    const listed = await handle(
      new Request("http://tinyhands.test/v1/conversations")
    );
    expect(await listed.json()).toEqual({
      conversations: [{ conversationId: "c1", createdAt: 10, running: false }],
    });
  });

  it("应用错误映射成稳定 code，而不是暴露 class/stack", async () => {
    const host = fakeHost({
      create: vi.fn(async () => {
        throw new ConversationExistsError("same");
      }),
    });
    const handle = createTinyhandsFetchHandler({ host });
    const response = await handle(
      new Request("http://tinyhands.test/v1/conversations", {
        method: "POST",
        body: "{}",
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "conversation_exists",
        message: "conversation 已存在：same",
      },
    });
  });

  it("SSE 使用 Last-Event-ID，持久事件带 id，Delta 不带 id，并发送终态控制帧", async () => {
    const event: PublicStreamItem = {
      id: "evt-2",
      seq: 2,
      timestamp: 2,
      source: "user",
      type: "user_message",
      text: "hello",
    };
    const delta: PublicStreamItem = {
      delta: { kind: "thinking", phase: "chunk", text: "x" },
    };
    const events = vi.fn(async () =>
      subscription([event, delta], "conversation_deleted")
    );
    const host = fakeHost({ events });
    const handle = createTinyhandsFetchHandler({ host });
    const response = await handle(
      new Request("http://tinyhands.test/v1/conversations/c1/events?afterSeq=1", {
        headers: { "last-event-id": "7" },
      })
    );
    const body = await response.text();

    expect(events).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ afterSeq: 7, signal: expect.any(AbortSignal) })
    );
    expect(body).toContain("id: 2\n");
    expect(body).toContain(`data: ${JSON.stringify(delta)}\n\n`);
    expect(body).toContain("event: tinyhands.control");
    expect(body).toContain('"code":"conversation_deleted"');
  });
});
