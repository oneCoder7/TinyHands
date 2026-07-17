import { describe, expect, it } from "vitest";
import type { Response } from "openai/resources/responses/responses";
import type { ChatCompletion } from "openai/resources/chat/completions/completions";
import {
  createOpenAIReplayScope,
  fromOpenAIChatCompletion,
  fromOpenAIResponse,
  normalizeOpenAIChatUsage,
  normalizeOpenAIResponseUsage,
  toOpenAIChatMessages,
  toOpenAIChatTools,
  toOpenAIResponseInput,
  toOpenAIResponseTools,
} from "../openai-mappers.js";
import type { Message, ProviderReplayState } from "../types.js";
import { finishTool } from "../../tools/finish.js";

const scope = createOpenAIReplayScope("gpt-test", "https://api.openai.com/v1/");

function response(overrides: Record<string, unknown> = {}): Response {
  return {
    status: "completed",
    output: [],
    usage: undefined,
    incomplete_details: null,
    ...overrides,
  } as unknown as Response;
}

function chatCompletion(overrides: Record<string, unknown> = {}): ChatCompletion {
  return {
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
    ...overrides,
  } as unknown as ChatCompletion;
}

describe("OpenAI Responses mapper", () => {
  it("映射 reasoning/message/function_call，并保留可回放顺序与 call_id", () => {
    const mapped = fromOpenAIResponse(
      response({
        output: [
          {
            type: "reasoning",
            id: "rs-1",
            status: "completed",
            summary: [{ type: "summary_text", text: "summary" }],
            encrypted_content: "ciphertext",
          },
          {
            type: "message",
            id: "msg-1",
            role: "assistant",
            status: "completed",
            phase: "commentary",
            content: [
              { type: "output_text", text: "working", annotations: [] },
            ],
          },
          {
            type: "function_call",
            id: "fc-1",
            call_id: "call-1",
            status: "completed",
            name: "finish",
            arguments: '{"result":"done"}',
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          input_tokens_details: { cached_tokens: 30, cache_write_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 8 },
        },
      }),
      scope
    );

    expect(mapped).toMatchObject({
      stopReason: "tool_use",
      text: "working",
      toolCalls: [
        { id: "call-1", name: "finish", args: { result: "done" } },
      ],
      usage: {
        status: "reported",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cacheReadInputTokens: 30,
          reasoningTokens: 8,
        },
      },
    });
    expect(mapped.providerReplay?.items.map((item) => item.type)).toEqual([
      "reasoning",
      "assistant_message",
      "function_call",
    ]);

    const replayed = toOpenAIResponseInput(
      [
        {
          role: "assistant",
          text: mapped.text,
          toolCalls: mapped.toolCalls,
          providerReplay: mapped.providerReplay,
        },
        {
          role: "tool",
          toolResult: { toolCallId: "call-1", content: "done", isError: false },
        },
      ],
      scope
    );
    expect(replayed.map((item) => item.type)).toEqual([
      "reasoning",
      "message",
      "function_call",
      "function_call_output",
    ]);
    expect(replayed[0]).toMatchObject({ encrypted_content: "ciphertext" });
    expect(replayed[2]).toMatchObject({ id: "fc-1", call_id: "call-1" });
    expect(replayed[3]).toMatchObject({ call_id: "call-1", output: "done" });
  });

  it("scope 不匹配时只从 canonical 内容重建，不发送密文", () => {
    const replay: ProviderReplayState = {
      kind: "openai_responses",
      version: 1,
      scope,
      items: [
        {
          type: "reasoning",
          id: "rs-1",
          summary: [],
          encryptedContent: "must-not-leak",
        },
      ],
    };
    const message: Message = {
      role: "assistant",
      text: "canonical",
      toolCalls: [{ id: "call-1", name: "finish", args: { result: "ok" } }],
      providerReplay: replay,
    };
    const input = toOpenAIResponseInput(
      [message],
      createOpenAIReplayScope("other-model", "https://api.openai.com/v1")
    );
    expect(input.map((item) => item.type)).toEqual(["message", "function_call"]);
    expect(JSON.stringify(input)).not.toContain("must-not-leak");
  });

  it("拒绝态和 incomplete 显式映射，不返回 replay 或半截工具调用", () => {
    expect(
      fromOpenAIResponse(
        response({
          output: [
            {
              type: "message",
              id: "m",
              role: "assistant",
              status: "completed",
              content: [{ type: "refusal", refusal: "no" }],
            },
          ],
        }),
        scope
      )
    ).toMatchObject({ stopReason: "refusal", toolCalls: [] });

    const incomplete = fromOpenAIResponse(
      response({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          {
            type: "function_call",
            id: "partial",
            call_id: "call-partial",
            status: "incomplete",
            name: "finish",
            arguments: "{",
          },
        ],
      }),
      scope
    );
    expect(incomplete).toMatchObject({ stopReason: "max_tokens", toolCalls: [] });
    expect(incomplete.providerReplay).toBeUndefined();
  });

  it("reasoning 缺密文、未知 output item、非法工具 JSON 都 fail closed", () => {
    expect(() =>
      fromOpenAIResponse(
        response({
          output: [
            { type: "reasoning", id: "rs", summary: [], encrypted_content: null },
          ],
        }),
        scope
      )
    ).toThrow("缺少 encrypted content");
    expect(() =>
      fromOpenAIResponse(
        response({ output: [{ type: "web_search_call" }] }),
        scope
      )
    ).toThrow("不支持的 output item");
    expect(() =>
      fromOpenAIResponse(
        response({
          output: [
            {
              type: "function_call",
              id: "fc",
              call_id: "call",
              status: "completed",
              name: "finish",
              arguments: "[]",
            },
          ],
        }),
        scope
      )
    ).toThrow("必须是 JSON object");
  });
});

describe("OpenAI Chat mapper", () => {
  it("映射 system/canonical/tool 消息和 non-strict function tools", () => {
    const messages = toOpenAIChatMessages(
      [
        { role: "user", text: "go" },
        {
          role: "assistant",
          toolCalls: [{ id: "call-1", name: "finish", args: { result: "ok" } }],
        },
        {
          role: "tool",
          toolResult: { toolCallId: "call-1", content: "ok", isError: false },
        },
      ],
      ["system-a", "system-b"]
    );
    expect(messages[0]).toEqual({
      role: "system",
      content: "system-a\n\nsystem-b",
    });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "call-1", function: { name: "finish" } }],
    });
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    expect(toOpenAIResponseTools([finishTool])[0]).toMatchObject({ strict: false });
    expect(toOpenAIChatTools([finishTool])[0]).toMatchObject({
      function: { strict: false },
    });
  });

  it("映射 tool calls、refusal 与拒绝态", () => {
    expect(
      fromOpenAIChatCompletion(
        chatCompletion({
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              logprobs: null,
              message: {
                role: "assistant",
                content: null,
                refusal: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "finish", arguments: '{"result":"ok"}' },
                  },
                ],
              },
            },
          ],
        })
      )
    ).toMatchObject({
      stopReason: "tool_use",
      toolCalls: [{ id: "call-1", args: { result: "ok" } }],
    });

    expect(
      fromOpenAIChatCompletion(
        chatCompletion({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              logprobs: null,
              message: { role: "assistant", content: null, refusal: "no" },
            },
          ],
        })
      ).stopReason
    ).toBe("refusal");
  });
});

describe("OpenAI usage normalizer", () => {
  it("校验总数与 breakdown 边界，且缺失不伪造为 0", () => {
    expect(normalizeOpenAIResponseUsage(undefined)).toEqual({
      status: "not_reported",
    });
    expect(
      normalizeOpenAIResponseUsage({
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 99,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      })
    ).toEqual({ status: "invalid" });
    expect(
      normalizeOpenAIChatUsage({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 11 },
      })
    ).toEqual({ status: "invalid" });
  });
});
