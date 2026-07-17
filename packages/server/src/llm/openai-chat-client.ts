import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions/completions";
import type { ChatOptions, LLMClient } from "./llm-client.js";
import type { LLMCallIdentity, LLMResponse, Message } from "./types.js";
import type { Tool } from "../tools/tool.js";
import {
  fromOpenAIChatCompletion,
  toOpenAIChatMessages,
  toOpenAIChatTools,
} from "./openai-mappers.js";

type ChatParams = Omit<ChatCompletionCreateParamsNonStreaming, "stream">;

/** 显式兼容模式；不会在 Responses 失败后自动切换到这里。 */
export class OpenAIChatCompletionsClient implements LLMClient {
  readonly identity: LLMCallIdentity;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(
    opts: {
      apiKey: string;
      baseURL: string;
      model: string;
      maxTokens?: number;
    },
    client?: OpenAI
  ) {
    this.client =
      client ??
      new OpenAI({
        apiKey: opts.apiKey,
        baseURL: opts.baseURL,
        maxRetries: 2,
      });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 4096;
    this.identity = {
      provider: "openai",
      model: opts.model,
      apiMode: "chat_completions",
    };
  }

  async chat(
    messages: Message[],
    tools: Tool[],
    opts: ChatOptions = {}
  ): Promise<LLMResponse> {
    const mappedTools = toOpenAIChatTools(tools);
    const params: ChatParams = {
      model: this.model,
      messages: toOpenAIChatMessages(messages, opts.systemContext),
      max_completion_tokens: opts.maxTokens ?? this.maxTokens,
      store: false,
      ...(mappedTools.length ? { tools: mappedTools } : {}),
    };

    let completion: ChatCompletion;
    if (opts.onDelta) {
      const stream = this.client.chat.completions.stream(
        { ...params, stream_options: { include_usage: true } },
        { signal: opts.signal }
      );
      completion = await stream.finalChatCompletion();
    } else {
      completion = await this.client.chat.completions.create(
        { ...params, stream: false },
        { signal: opts.signal }
      );
    }
    return fromOpenAIChatCompletion(completion);
  }
}
