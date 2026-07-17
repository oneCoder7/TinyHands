import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { Response } from "openai/resources/responses/responses";
import type { ChatCompletion } from "openai/resources/chat/completions/completions";
import { OpenAIResponsesClient } from "../openai-responses-client.js";
import { OpenAIChatCompletionsClient } from "../openai-chat-client.js";

const completedResponse = {
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg-1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "ok", annotations: [] }],
    },
  ],
  usage: undefined,
  incomplete_details: null,
} as unknown as Response;

const completedChat = {
  id: "chat-1",
  object: "chat.completion",
  created: 1,
  model: "gpt-test",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      logprobs: null,
      message: { role: "assistant", content: "ok", refusal: null },
    },
  ],
} as unknown as ChatCompletion;

describe("OpenAIResponsesClient", () => {
  it("非流式发送 stateless/replay 固定参数和 per-call 覆盖", async () => {
    const create = vi.fn(async (..._args: any[]) => completedResponse);
    const client = {
      responses: { create, stream: vi.fn() },
    } as unknown as OpenAI;
    const adapter = new OpenAIResponsesClient(
      {
        apiKey: "key",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-test",
        maxTokens: 100,
      },
      client
    );
    const controller = new AbortController();

    const result = await adapter.chat([{ role: "user", text: "go" }], [], {
      systemContext: ["a", "b"],
      maxTokens: 42,
      signal: controller.signal,
    });

    expect(adapter.identity).toEqual({
      provider: "openai",
      model: "gpt-test",
      apiMode: "responses",
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]![0]).toMatchObject({
      model: "gpt-test",
      instructions: "a\n\nb",
      max_output_tokens: 42,
      store: false,
      include: ["reasoning.encrypted_content"],
      truncation: "disabled",
      stream: false,
      tools: [],
    });
    expect(create.mock.calls[0]![1]).toEqual({ signal: controller.signal });
    expect(result).toMatchObject({ stopReason: "end_turn", text: "ok" });
  });

  it("有 onDelta 时使用官方 stream helper 的 finalResponse", async () => {
    const finalResponse = vi.fn(async () => completedResponse);
    const stream = vi.fn((..._args: any[]) => ({ finalResponse }));
    const client = {
      responses: { create: vi.fn(), stream },
    } as unknown as OpenAI;
    const adapter = new OpenAIResponsesClient(
      {
        apiKey: "key",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-test",
      },
      client
    );
    const controller = new AbortController();

    await adapter.chat([{ role: "user", text: "go" }], [], {
      onDelta: vi.fn(),
      signal: controller.signal,
    });

    expect(stream).toHaveBeenCalledOnce();
    expect(stream.mock.calls[0]![1]).toEqual({ signal: controller.signal });
    expect(finalResponse).toHaveBeenCalledOnce();
  });
});

describe("OpenAIChatCompletionsClient", () => {
  it("非流式使用 canonical Chat 字段且显式 store=false", async () => {
    const create = vi.fn(async (..._args: any[]) => completedChat);
    const client = {
      chat: { completions: { create, stream: vi.fn() } },
    } as unknown as OpenAI;
    const adapter = new OpenAIChatCompletionsClient(
      {
        apiKey: "key",
        baseURL: "https://gateway.example.com/v1",
        model: "served-model",
        maxTokens: 100,
      },
      client
    );

    await adapter.chat([{ role: "user", text: "go" }], [], {
      systemContext: ["system"],
      maxTokens: 55,
    });

    expect(adapter.identity).toEqual({
      provider: "openai",
      model: "served-model",
      apiMode: "chat_completions",
    });
    expect(create.mock.calls[0]![0]).toMatchObject({
      model: "served-model",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "go" },
      ],
      max_completion_tokens: 55,
      store: false,
      stream: false,
    });
  });

  it("有 onDelta 时请求 usage chunk 并使用 finalChatCompletion", async () => {
    const finalChatCompletion = vi.fn(async () => completedChat);
    const stream = vi.fn((..._args: any[]) => ({ finalChatCompletion }));
    const client = {
      chat: { completions: { create: vi.fn(), stream } },
    } as unknown as OpenAI;
    const adapter = new OpenAIChatCompletionsClient(
      {
        apiKey: "key",
        baseURL: "https://api.openai.com/v1",
        model: "gpt-test",
      },
      client
    );
    const controller = new AbortController();

    await adapter.chat([{ role: "user", text: "go" }], [], {
      onDelta: vi.fn(),
      signal: controller.signal,
    });

    expect(stream.mock.calls[0]![0]).toMatchObject({
      stream_options: { include_usage: true },
    });
    expect(stream.mock.calls[0]![1]).toEqual({ signal: controller.signal });
    expect(finalChatCompletion).toHaveBeenCalledOnce();
  });
});
