import Anthropic from "@anthropic-ai/sdk";
import { toJSONSchema } from "zod/v4";
import type { ChatOptions, LLMClient } from "./llm-client.js";
import type {
  LLMCallIdentity,
  LLMResponse,
  LLMUsageReport,
  Message,
  ToolCall,
  ThinkingBlock,
} from "./types.js";
import type { Tool } from "../tools/tool.js";

/**
 * AnthropicClient —— LLMClient 的默认实现。全项目唯一 import @anthropic-ai/sdk 的
 * 文件,职责是中性类型 ⇄ Anthropic 协议的双向翻译,外部只拿中性类型。
 *
 * extended thinking + 流式:开启 thinking 后响应带 thinking block(含 signature),
 * 翻译成中性 ThinkingBlock;opts.onDelta 存在时走流式推 Delta;回传时把上一轮
 * thinking block(带签名)塞回 assistant message,否则多轮 400。
 */
export class AnthropicClient implements LLMClient {
  readonly identity: LLMCallIdentity;
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private thinkingBudget: number;

  constructor(
    opts: {
      apiKey: string;
      baseURL?: string;
      model: string;
      maxTokens?: number;
      /** extended thinking 预算 token；0 表示关闭 thinking */
      thinkingBudget?: number;
    },
    client?: Anthropic
  ) {
    this.client =
      client ?? new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
    this.model = opts.model;
    this.identity = {
      provider: "anthropic",
      model: opts.model,
      apiMode: "messages",
    };
    this.maxTokens = opts.maxTokens ?? 4096;
    this.thinkingBudget = opts.thinkingBudget ?? 0;
  }

  async chat(
    messages: Message[],
    tools: Tool[],
    opts: ChatOptions = {}
  ): Promise<LLMResponse> {
    // —— 入向翻译:中性 Message[] → Anthropic messages[]
    const anthropicMessages = messages
      .map((m) => this.toAnthropicMessage(m))
      .filter(
        (m) =>
          !(
            m.role === "assistant" &&
            Array.isArray(m.content) &&
            m.content.length === 0
          )
      );

    // —— 工具翻译:Tool[] → Anthropic tool 定义(schema → JSON Schema)
    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: this.toJsonSchema(t.schema),
    }));

    // thinking 开启时,max_tokens 必须 > budget_tokens(API 约束)
    const thinking =
      this.thinkingBudget > 0
        ? ({ type: "enabled", budget_tokens: this.thinkingBudget } as const)
        : undefined;
    const configuredMaxTokens = opts.maxTokens ?? this.maxTokens;
    const maxTokens =
      thinking && configuredMaxTokens <= this.thinkingBudget
        ? this.thinkingBudget + 1024
        : configuredMaxTokens;
    const system = opts.systemContext?.filter(Boolean).join("\n\n") || undefined;

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: maxTokens,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      system,
      ...(thinking ? { thinking } : {}),
    };

    // —— 没有 onDelta:非流式一次拿完。signal 经 RequestOptions 透传,abort 时 SDK
    //    中止底层请求并 reject,调用方以 signal.aborted 识别。
    if (!opts.onDelta) {
      const resp = await this.client.messages.create(params, {
        signal: opts.signal,
      });
      return this.fromAnthropicResponse(resp);
    }

    // —— 有 onDelta:流式,逐个 stream event 映射成 Delta 推出
    return this.chatStreaming(params, opts.onDelta, opts.signal);
  }

  /** 流式路径:解析 SSE,边推 Delta 边攒最终 message */
  private async chatStreaming(
    params: Anthropic.MessageCreateParamsNonStreaming,
    onDelta: NonNullable<ChatOptions["onDelta"]>,
    signal?: AbortSignal
  ): Promise<LLMResponse> {
    // abort 表现有两种:for-await 中抛错,或恰好正常走完但 finalMessage() reject ——
    // 两种都以异常冒出本方法,由调用方统一识别。
    const stream = this.client.messages.stream(params, { signal });
    // 记住每个 block index 是不是 thinking,好让 stop 只对思考块发 end,
    // 避免 text/tool_use 块结束时误发「撤思考框」。
    const thinkingIndexes = new Set<number>();

    for await (const ev of stream) {
      if (ev.type === "content_block_start") {
        if (ev.content_block.type === "thinking") {
          thinkingIndexes.add(ev.index);
          onDelta({ kind: "thinking", phase: "start" });
        }
      } else if (ev.type === "content_block_delta") {
        // signature_delta 不广播(SDK 会攒进 finalMessage)
        if (ev.delta.type === "thinking_delta") {
          onDelta({ kind: "thinking", phase: "chunk", text: ev.delta.thinking });
        }
      } else if (ev.type === "content_block_stop") {
        if (thinkingIndexes.has(ev.index)) {
          onDelta({ kind: "thinking", phase: "end" });
        }
      }
    }

    // 攒完 → 拿最终 message,走同一套出向翻译(signature 已由 SDK 攒好)
    const finalMsg = await stream.finalMessage();
    return this.fromAnthropicResponse(finalMsg);
  }

  /** 中性 Message → Anthropic message */
  private toAnthropicMessage(m: Message): Anthropic.MessageParam {
    if (m.role === "user") {
      // {role:"user", text} → {role:"user", content:[{type:"text"}]}
      return { role: "user", content: m.text ?? "" };
    }

    if (m.role === "assistant") {
      // thinking block 必须排在最前,且带 signature 原样回传,否则多轮 400
      type BlockParam = Exclude<Anthropic.MessageParam["content"], string>[number];
      const blocks: BlockParam[] = [];
      for (const tb of m.thinkingBlocks ?? []) {
        blocks.push({
          type: "thinking",
          thinking: tb.thinking,
          signature: tb.signature,
        });
      }
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.args,
        });
      }
      return { role: "assistant", content: blocks };
    }

    // m.role === "tool":工具结果 → 装进一条 role:"user" 的 tool_result block
    const tr = m.toolResult!;
    return {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: tr.toolCallId, // 必须与对应 tool_use id 配对,配错 400
          content: tr.content,
          is_error: tr.isError,
        },
      ],
    };
  }

  /** Anthropic 响应 → 中性 LLMResponse */
  private fromAnthropicResponse(resp: Anthropic.Message): LLMResponse {
    let text = "";
    const toolCalls: ToolCall[] = [];
    const thinkingBlocks: ThinkingBlock[] = [];

    // 遍历响应的 content block,按 type 拆分
    for (const block of resp.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: (block.input ?? {}) as Record<string, unknown>,
        });
      } else if (block.type === "thinking") {
        // thinking + signature 成对回传;redacted_thinking 暂不处理(已知缺口)
        thinkingBlocks.push({
          thinking: block.thinking,
          signature: block.signature,
        });
      }
    }

    return {
      stopReason: normalizeAnthropicStopReason(resp.stop_reason),
      text,
      toolCalls,
      thinkingBlocks: thinkingBlocks.length ? thinkingBlocks : undefined,
      usage: normalizeAnthropicUsage(resp.usage),
    };
  }

  /** Zod schema → JSON Schema(给 LLM 的工具入参定义) */
  private toJsonSchema(schema: unknown): Anthropic.Tool.InputSchema {
    // schema 必须用 zod/v4 创建(见 tools/*.ts 的 import);v3 经典 schema 会报 "reading 'def'"
    return toJSONSchema(schema as any) as unknown as Anthropic.Tool.InputSchema;
  }
}

function normalizeAnthropicStopReason(
  reason: Anthropic.Messages.StopReason | null
): LLMResponse["stopReason"] {
  switch (reason) {
    case null:
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "pause_turn":
      throw new Error("Anthropic 协议错误：不支持 pause_turn");
  }
}

/** Anthropic usage → 中立 usage；任一已报告字段非法时整份标为 invalid。 */
export function normalizeAnthropicUsage(
  usage: Anthropic.Usage | null | undefined
): LLMUsageReport {
  if (!usage) return { status: "not_reported" };

  const required = [usage.input_tokens, usage.output_tokens];
  const optional = [
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
    usage.output_tokens_details?.thinking_tokens,
  ].filter((value): value is number => value !== null && value !== undefined);
  if (![...required, ...optional].every(isTokenCount)) {
    return { status: "invalid" };
  }

  const inputTokens =
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  const outputTokens = usage.output_tokens;
  const totalTokens = inputTokens + outputTokens;
  const reasoningTokens = usage.output_tokens_details?.thinking_tokens;

  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(totalTokens) ||
    (reasoningTokens !== null &&
      reasoningTokens !== undefined &&
      reasoningTokens > outputTokens)
  ) {
    return { status: "invalid" };
  }

  return {
    status: "reported",
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(usage.cache_read_input_tokens !== null &&
      usage.cache_read_input_tokens !== undefined
        ? { cacheReadInputTokens: usage.cache_read_input_tokens }
        : {}),
      ...(usage.cache_creation_input_tokens !== null &&
      usage.cache_creation_input_tokens !== undefined
        ? { cacheCreationInputTokens: usage.cache_creation_input_tokens }
        : {}),
      ...(reasoningTokens !== null && reasoningTokens !== undefined
        ? { reasoningTokens }
        : {}),
    },
  };
}

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
