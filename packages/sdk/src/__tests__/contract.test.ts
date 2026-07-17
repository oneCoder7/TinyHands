import { describe, expect, it, vi } from "vitest";
import { createTinyhandsFetchHandler } from "@tinyhands/server/http";
import { TinyhandsClient } from "../client.js";

describe("SDK -> Fetch handler contract", () => {
  it("通过真实 protocol handler 完成 create/list/delete", async () => {
    const records = new Map<string, { createdAt: number; running: boolean }>();
    const host = {
      conversations: {
        async create(input: { conversationId?: string }) {
          const conversationId = input.conversationId ?? "generated";
          records.set(conversationId, { createdAt: 10, running: false });
          return { conversationId, createdAt: 10, running: false };
        },
        async list() {
          return [...records].map(([conversationId, value]) => ({
            conversationId,
            ...value,
          }));
        },
        async delete(conversationId: string) {
          records.delete(conversationId);
          return { deleted: true as const };
        },
      },
    } as never;
    const handler = createTinyhandsFetchHandler({
      host,
      authorize: (request) => {
        if (request.headers.get("authorization") === "Bearer contract") return;
        return Response.json({ error: "unauthorized" }, { status: 401 });
      },
    });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (input, init) => handler(new Request(input, init))
    );
    const client = new TinyhandsClient({
      baseUrl: "https://contract.test",
      fetch,
      headers: { authorization: "Bearer contract" },
    });

    const conversation = await client.conversations.create({ conversationId: "c1" });
    expect(await client.conversations.list()).toEqual([
      { conversationId: "c1", createdAt: 10, running: false },
    ]);
    expect(await conversation.delete()).toEqual({ deleted: true });
    expect(await client.conversations.list()).toEqual([]);
  });
});
