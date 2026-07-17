import { describe, expect, it, vi } from "vitest";
import { TinyhandsClient, TinyhandsClientError } from "../client.js";

describe("TinyhandsClient", () => {
  it("命令使用 /v1 且不自动重试，动态 headers 每次求值", async () => {
    const headers = vi.fn(async () => ({ authorization: "Bearer token" }));
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer token");
      if (request.method === "POST" && request.url.endsWith("/v1/conversations")) {
        return Response.json({
          conversationId: "c1",
          createdAt: 1,
          running: false,
        }, { status: 201 });
      }
      if (request.url.endsWith("/messages")) {
        return Response.json({ accepted: true, running: true, triggerId: "t1" });
      }
      throw new Error(`unexpected request: ${request.method} ${request.url}`);
    });
    const client = new TinyhandsClient({
      baseUrl: "https://example.test/tinyhands/",
      fetch,
      headers,
    });

    const conversation = await client.conversations.create({ conversationId: "c1" });
    expect(conversation.conversationId).toBe("c1");
    expect(await conversation.send("hello")).toEqual({
      accepted: true,
      running: true,
      triggerId: "t1",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(headers).toHaveBeenCalledTimes(2);
  });

  it("SSE 断线后按最后持久 id 重连，Delta 不推进锚点", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (requests.length === 1) {
        return sse([
          "retry: 0\n\n",
          'id: 2\ndata: {"id":"evt-2","seq":2,"timestamp":2,"source":"user","type":"user_message","text":"hi"}\n\n',
          'data: {"delta":{"kind":"thinking","phase":"chunk","text":"x"}}\n\n',
        ]);
      }
      expect(request.headers.get("last-event-id")).toBe("2");
      return sse([
        'event: tinyhands.control\ndata: {"type":"stream_closed","code":"conversation_deleted","message":"gone"}\n\n',
      ]);
    });
    const client = new TinyhandsClient({ baseUrl: "https://example.test", fetch });
    const seen: unknown[] = [];

    let terminal: unknown;
    try {
      for await (const item of client.conversation("c1").events()) seen.push(item);
    } catch (error) {
      terminal = error;
    }

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ seq: 2, type: "user_message" });
    expect(seen[1]).toEqual({
      delta: { kind: "thinking", phase: "chunk", text: "x" },
    });
    expect(terminal).toBeInstanceOf(TinyhandsClientError);
    expect(terminal).toMatchObject({ code: "conversation_deleted" });
    expect(requests).toHaveLength(2);
  });

  it("非 2xx 响应抛出带稳定 code/status 的 TinyhandsClientError", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          error: {
            code: "conversation_not_found",
            message: "missing",
          },
        },
        { status: 404 }
      )
    );
    const client = new TinyhandsClient({ baseUrl: "https://example.test", fetch });

    await expect(client.conversation("missing").interrupt()).rejects.toMatchObject({
      name: "TinyhandsClientError",
      code: "conversation_not_found",
      status: 404,
      message: "missing",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("AbortSignal 会取消底层 SSE reader 并正常结束迭代", async () => {
    const cancelled = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        new ReadableStream({
          pull() {},
          cancel: cancelled,
        }),
        { headers: { "content-type": "text/event-stream" } }
      )
    );
    const controller = new AbortController();
    const client = new TinyhandsClient({ baseUrl: "https://example.test", fetch });
    const iterator = client
      .conversation("c1")
      .events({ signal: controller.signal })[Symbol.asyncIterator]();
    const pending = iterator.next();

    controller.abort();

    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("调用者提前退出事件迭代时会取消底层 SSE reader", async () => {
    const cancelled = vi.fn();
    const encoder = new TextEncoder();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'id: 1\ndata: {"id":"evt-1","seq":1,"timestamp":1,"source":"user","type":"user_message","text":"hi"}\n\n'
              )
            );
          },
          cancel: cancelled,
        }),
        { headers: { "content-type": "text/event-stream" } }
      )
    );
    const client = new TinyhandsClient({ baseUrl: "https://example.test", fetch });
    const iterator = client.conversation("c1").events()[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { seq: 1, type: "user_message" },
    });
    await iterator.return?.();

    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});

function sse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}
