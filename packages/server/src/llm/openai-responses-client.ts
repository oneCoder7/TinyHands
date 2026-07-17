import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses";
import type { ChatOptions, LLMClient } from "./llm-client.js";
import type { LLMCallIdentity, LLMResponse, Message } from "./types.js";
import type { Tool } from "../tools/tool.js";
import {
  createOpenAIReplayScope,
  fromOpenAIResponse,
  joinSystemContext,
  toOpenAIResponseInput,
  toOpenAIResponseTools,
} from "./openai-mappers.js";

type ResponsesParams = Omit<ResponseCreateParamsNonStreaming, "stream">;

/** OpenAI Responses adapter；远端不存状态，本地事件负责完整 item replay。 */
export class OpenAIResponsesClient implements LLMClient {
  readonly identity: LLMCallIdentity;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly scope: ReturnType<typeof createOpenAIReplayScope>;

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
    this.scope = createOpenAIReplayScope(opts.model, opts.baseURL);
    this.identity = {
      provider: "openai",
      model: opts.model,
      apiMode: "responses",
    };
  }

  async chat(
    messages: Message[],
    tools: Tool[],
    opts: ChatOptions = {}
  ): Promise<LLMResponse> {
    const instructions = joinSystemContext(opts.systemContext);
    const params: ResponsesParams = {
      model: this.model,
      input: toOpenAIResponseInput(messages, this.scope),
      tools: toOpenAIResponseTools(tools),
      max_output_tokens: opts.maxTokens ?? this.maxTokens,
      store: false,
      include: ["reasoning.encrypted_content"],
      truncation: "disabled",
      ...(instructions ? { instructions } : {}),
    };

    let response: Response;
    if (opts.onDelta) {
      const stream = this.client.responses.stream(params, { signal: opts.signal });
      response = await stream.finalResponse();
    } else {
      response = await this.client.responses.create(
        { ...params, stream: false },
        { signal: opts.signal }
      );
    }
    return fromOpenAIResponse(response, this.scope);
  }
}
