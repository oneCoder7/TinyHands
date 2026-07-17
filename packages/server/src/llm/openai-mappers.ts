import { createHash } from "node:crypto";
import { toJSONSchema } from "zod/v4";
import type {
  FunctionTool,
  Response,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseReasoningItem,
  ResponseUsage,
} from "openai/resources/responses/responses";
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions/completions";
import type { CompletionUsage } from "openai/resources/completions";
import type {
  LLMResponse,
  LLMUsageReport,
  Message,
  OpenAIResponsesReplayItem,
  OpenAIResponsesReplayScope,
  ProviderReplayState,
  ToolCall,
} from "./types.js";
import type { Tool } from "../tools/tool.js";

export function joinSystemContext(parts: string[] | undefined): string | undefined {
  return parts?.filter(Boolean).join("\n\n") || undefined;
}

export function createOpenAIReplayScope(
  model: string,
  baseURL: string
): OpenAIResponsesReplayScope {
  const endpoint = normalizeEndpoint(baseURL);
  return {
    provider: "openai",
    apiMode: "responses",
    model,
    endpointHash: createHash("sha256").update(endpoint).digest("hex"),
  };
}

function normalizeEndpoint(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("OpenAI baseURL 只支持 http/https");
  }
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function matchesReplayScope(
  replay: ProviderReplayState | undefined,
  scope: OpenAIResponsesReplayScope
): replay is Extract<ProviderReplayState, { kind: "openai_responses" }> {
  return (
    replay?.kind === "openai_responses" &&
    replay.version === 1 &&
    replay.scope.provider === scope.provider &&
    replay.scope.apiMode === scope.apiMode &&
    replay.scope.model === scope.model &&
    replay.scope.endpointHash === scope.endpointHash
  );
}

export function toOpenAIResponseInput(
  messages: Message[],
  scope: OpenAIResponsesReplayScope
): ResponseInputItem[] {
  const input: ResponseInputItem[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      input.push({ type: "message", role: "user", content: message.text ?? "" });
      continue;
    }

    if (message.role === "tool") {
      if (!message.toolResult) {
        throw new Error("OpenAI Responses 协议错误：tool message 缺少结果");
      }
      input.push({
        type: "function_call_output",
        call_id: message.toolResult.toolCallId,
        output: message.toolResult.content,
      });
      continue;
    }

    if (matchesReplayScope(message.providerReplay, scope)) {
      for (const item of message.providerReplay.items) {
        input.push(toResponseReplayInput(item));
      }
      continue;
    }

    if (message.text) {
      input.push({ type: "message", role: "assistant", content: message.text });
    }
    for (const call of message.toolCalls ?? []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args),
      });
    }
  }

  return input;
}

function toResponseReplayInput(item: OpenAIResponsesReplayItem): ResponseInputItem {
  switch (item.type) {
    case "reasoning":
      return {
        type: "reasoning",
        id: item.id,
        summary: item.summary,
        encrypted_content: item.encryptedContent,
      } satisfies ResponseReasoningItem;
    case "assistant_message":
      return {
        type: "message",
        role: "assistant",
        content: item.content,
        ...(item.phase ? { phase: item.phase } : {}),
      };
    case "function_call":
      return {
        type: "function_call",
        id: item.id,
        call_id: item.callId,
        name: item.name,
        arguments: item.arguments,
      } satisfies ResponseFunctionToolCall;
  }
}

export function toOpenAIResponseTools(tools: Tool[]): FunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: toolSchema(tool),
    strict: false,
  }));
}

export function toOpenAIChatMessages(
  messages: Message[],
  systemContext?: string[]
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];
  const system = joinSystemContext(systemContext);
  if (system) result.push({ role: "system", content: system });

  for (const message of messages) {
    if (message.role === "user") {
      result.push({ role: "user", content: message.text ?? "" });
      continue;
    }
    if (message.role === "tool") {
      if (!message.toolResult) {
        throw new Error("OpenAI Chat 协议错误：tool message 缺少结果");
      }
      result.push({
        role: "tool",
        tool_call_id: message.toolResult.toolCallId,
        content: message.toolResult.content,
      });
      continue;
    }

    const toolCalls = (message.toolCalls ?? []).map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    if (!message.text && toolCalls.length === 0) continue;
    result.push({
      role: "assistant",
      content: message.text ?? null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
  }

  return result;
}

export function toOpenAIChatTools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toolSchema(tool),
      strict: false,
    },
  }));
}

function toolSchema(tool: Tool): Record<string, unknown> {
  return toJSONSchema(tool.schema as any) as Record<string, unknown>;
}

export function fromOpenAIResponse(
  response: Response,
  scope: OpenAIResponsesReplayScope
): LLMResponse {
  const usage = normalizeOpenAIResponseUsage(response.usage);

  if (response.status === "incomplete") {
    const text = inspectRejectedResponseOutput(response.output);
    const reason = response.incomplete_details?.reason;
    if (reason !== "max_output_tokens" && reason !== "content_filter") {
      throw new Error("OpenAI Responses 协议错误：未知 incomplete reason");
    }
    return {
      stopReason: reason === "max_output_tokens" ? "max_tokens" : "content_filter",
      text,
      toolCalls: [],
      usage,
    };
  }

  if (response.status !== "completed") {
    throw new Error("OpenAI Responses 协议错误：response 未完成");
  }

  let text = "";
  let refused = false;
  const toolCalls: ToolCall[] = [];
  const replayItems: OpenAIResponsesReplayItem[] = [];

  for (const item of response.output) {
    switch (item.type) {
      case "reasoning": {
        if (item.status && item.status !== "completed") {
          throw new Error("OpenAI Responses 协议错误：reasoning item 未完成");
        }
        const encryptedContent = requireEncryptedReasoning(item);
        replayItems.push({
          type: "reasoning",
          id: item.id,
          summary: item.summary.map((part) => ({ ...part })),
          encryptedContent,
        });
        break;
      }
      case "message": {
        if (item.status !== "completed") {
          throw new Error("OpenAI Responses 协议错误：assistant message 未完成");
        }
        let messageText = "";
        for (const content of item.content) {
          if (content.type === "output_text") {
            messageText += content.text;
          } else if (content.type === "refusal") {
            refused = true;
          }
        }
        text += messageText;
        if (messageText || !refused) {
          replayItems.push({
            type: "assistant_message",
            content: messageText,
            ...(item.phase ? { phase: item.phase } : {}),
          });
        }
        break;
      }
      case "function_call": {
        if (item.status !== "completed" || !item.id) {
          throw new Error("OpenAI Responses 协议错误：function call 未完成");
        }
        const args = parseToolArguments(item.arguments, "OpenAI Responses");
        toolCalls.push({ id: item.call_id, name: item.name, args });
        replayItems.push({
          type: "function_call",
          id: item.id,
          callId: item.call_id,
          name: item.name,
          arguments: item.arguments,
        });
        break;
      }
      default:
        throw new Error("OpenAI Responses 协议错误：收到不支持的 output item");
    }
  }

  return {
    stopReason: refused ? "refusal" : toolCalls.length ? "tool_use" : "end_turn",
    text,
    toolCalls: refused ? [] : toolCalls,
    ...(!refused
      ? {
          providerReplay: {
            kind: "openai_responses" as const,
            version: 1 as const,
            scope,
            items: replayItems,
          },
        }
      : {}),
    usage,
  };
}

function inspectRejectedResponseOutput(output: Response["output"]): string {
  let text = "";
  for (const item of output) {
    switch (item.type) {
      case "reasoning":
        requireEncryptedReasoning(item);
        break;
      case "message":
        for (const content of item.content) {
          if (content.type === "output_text") text += content.text;
        }
        break;
      case "function_call":
        break;
      default:
        throw new Error("OpenAI Responses 协议错误：收到不支持的 output item");
    }
  }
  return text;
}

function requireEncryptedReasoning(item: ResponseReasoningItem): string {
  if (!item.encrypted_content) {
    throw new Error("OpenAI Responses 协议错误：reasoning 缺少 encrypted content");
  }
  return item.encrypted_content;
}

export function fromOpenAIChatCompletion(
  completion: ChatCompletion
): LLMResponse {
  const usage = normalizeOpenAIChatUsage(completion.usage);
  if (completion.choices.length !== 1) {
    throw new Error("OpenAI Chat 协议错误：响应必须恰好包含一个 choice");
  }

  const choice = completion.choices[0]!;
  const text = choice.message.content ?? "";
  if (choice.message.refusal !== null && choice.message.refusal !== undefined) {
    return { stopReason: "refusal", text, toolCalls: [], usage };
  }
  if (choice.finish_reason === "length") {
    return { stopReason: "max_tokens", text, toolCalls: [], usage };
  }
  if (choice.finish_reason === "content_filter") {
    return { stopReason: "content_filter", text, toolCalls: [], usage };
  }
  if (choice.finish_reason === "function_call") {
    throw new Error("OpenAI Chat 协议错误：不支持已废弃的 function_call");
  }

  const rawCalls = choice.message.tool_calls ?? [];
  if (choice.finish_reason === "stop") {
    if (rawCalls.length) {
      throw new Error("OpenAI Chat 协议错误：stop 响应含 tool calls");
    }
    return { stopReason: "end_turn", text, toolCalls: [], usage };
  }
  if (choice.finish_reason !== "tool_calls" || rawCalls.length === 0) {
    throw new Error("OpenAI Chat 协议错误：tool_calls 终态缺少调用");
  }

  const toolCalls = rawCalls.map((call): ToolCall => {
    if (call.type !== "function") {
      throw new Error("OpenAI Chat 协议错误：收到不支持的 tool call");
    }
    return {
      id: call.id,
      name: call.function.name,
      args: parseToolArguments(call.function.arguments, "OpenAI Chat"),
    };
  });
  return { stopReason: "tool_use", text, toolCalls, usage };
}

function parseToolArguments(raw: string, provider: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${provider} 协议错误：工具参数不是合法 JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${provider} 协议错误：工具参数必须是 JSON object`);
  }
  return value as Record<string, unknown>;
}

export function normalizeOpenAIResponseUsage(
  usage: ResponseUsage | null | undefined
): LLMUsageReport {
  if (!usage) return { status: "not_reported" };
  return normalizeUsage({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cacheReadInputTokens: usage.input_tokens_details?.cached_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
  });
}

export function normalizeOpenAIChatUsage(
  usage: CompletionUsage | null | undefined
): LLMUsageReport {
  if (!usage) return { status: "not_reported" };
  return normalizeUsage({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  });
}

function normalizeUsage(values: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  reasoningTokens?: number;
}): LLMUsageReport {
  const present = [
    values.inputTokens,
    values.outputTokens,
    values.totalTokens,
    values.cacheReadInputTokens,
    values.reasoningTokens,
  ].filter((value): value is number => value !== undefined);
  if (!present.every(isTokenCount)) return { status: "invalid" };
  if (
    values.totalTokens !== values.inputTokens + values.outputTokens ||
    (values.cacheReadInputTokens !== undefined &&
      values.cacheReadInputTokens > values.inputTokens) ||
    (values.reasoningTokens !== undefined &&
      values.reasoningTokens > values.outputTokens)
  ) {
    return { status: "invalid" };
  }
  return {
    status: "reported",
    usage: {
      inputTokens: values.inputTokens,
      outputTokens: values.outputTokens,
      totalTokens: values.totalTokens,
      ...(values.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: values.cacheReadInputTokens }
        : {}),
      ...(values.reasoningTokens !== undefined
        ? { reasoningTokens: values.reasoningTokens }
        : {}),
    },
  };
}

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
