/**
 * 中性 LLM 类型 —— 全项目共享的「通用货币」。
 *
 * 这里不出现任何 Anthropic 类型。业务代码(Agent/Tool/Conversation)只认这些中性
 * 类型；各 provider SDK 的具体结构只在 adapter / mapper 内部出现并被翻译掉。
 */
import type { Delta, ThinkingBlock, ToolCall } from "@tinyhands/protocol";
export type { Delta, ThinkingBlock, ToolCall } from "@tinyhands/protocol";

/** 消息角色 */
export type Role = "user" | "assistant" | "tool";

/** 一条工具调用意图（由 LLM 发起） */
/** 一条工具执行结果 */
export interface ToolResult {
  /** 原样配对 ToolCall.id(否则 API 400) */
  toolCallId: string;
  /** 执行输出(统一转字符串) */
  content: string;
  /** 是否执行出错 */
  isError: boolean;
}

/**
 * 工具 execute 的「裸结果」—— 不含 toolCallId。工具不知道自己被哪次 tool_use 触发,
 * id 是 Agent 编排层的事:工具只负责干活返回内容,Agent 补配对 id 组装成 ToolResult。
 */
export interface ToolOutput {
  content: string;
  isError: boolean;
}

export interface OpenAIResponsesReplayScope {
  provider: "openai";
  apiMode: "responses";
  model: string;
  /** effective endpoint 的 SHA-256；不持久化明文 URL。 */
  endpointHash: string;
}

export type OpenAIResponsesReplayItem =
  | {
      type: "reasoning";
      id: string;
      summary: Array<{ type: "summary_text"; text: string }>;
      encryptedContent: string;
    }
  | {
      type: "assistant_message";
      content: string;
      phase?: "commentary" | "final_answer";
    }
  | {
      type: "function_call";
      id: string;
      callId: string;
      name: string;
      /** Provider 返回的原始 JSON 字符串。 */
      arguments: string;
    };

/** 仅供匹配 adapter 恢复 provider 上下文；禁止进入公开事件视图。 */
export interface OpenAIResponsesReplayState {
  kind: "openai_responses";
  version: 1;
  scope: OpenAIResponsesReplayScope;
  items: OpenAIResponsesReplayItem[];
}

export type ProviderReplayState = OpenAIResponsesReplayState;

/** 一条消息（Conversation.messages 数组的元素） */
export interface Message {
  role: Role;
  /** assistant / user 的文字内容 */
  text?: string;
  /** assistant 发起的工具调用 */
  toolCalls?: ToolCall[];
  /** role==="tool" 时携带的执行结果 */
  toolResult?: ToolResult;
  /** assistant 上一轮的思考定稿块，投影回传给 API（带签名，否则多轮 400） */
  thinkingBlocks?: ThinkingBlock[];
  /** 仅供匹配 provider adapter 回放；其他 adapter 必须忽略。 */
  providerReplay?: ProviderReplayState;
}

/**
 * 思考块(extended thinking 的一段定稿)。
 *
 * 这是自定义的「中性」结构,不是 Anthropic SDK 类型。signature 是 Anthropic 私有
 * 防伪机制:多轮带工具调用时,上一轮 thinking 必须带 signature 原样回传,否则 API 400。
 * 把它包在自描述的 block 结构内,而非裸挂在通用 Event 顶层。
 */
/** 一次 LLM 调用所使用的稳定实现身份。 */
export interface LLMCallIdentity {
  provider: string;
  model: string;
  apiMode: "messages" | "chat_completions" | "responses" | (string & {});
}

/**
 * Provider 实际报告的 token 用量。input/output 是包含 cache/reasoning 的权威总数，
 * breakdown 字段只用于观察，不得再次计入 totalTokens。
 */
export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
}

/** usage 缺失或非法时明确保留状态，不用 0 冒充真实用量。 */
export type LLMUsageReport =
  | { status: "reported"; usage: LLMUsage }
  | { status: "not_reported" }
  | { status: "invalid" };

/**
 * Delta —— 流式过程中的「瞬态信号」。放在中性 types 层(而非 agent/events.ts):
 * LLMClient.chat 的 onDelta 回调要用它,而 llm 层不能反向依赖 agent 层。
 *
 * 它不是 Event:只广播、不入 events[]、不被投影、生成完即蒸发。phase + kind 两维:
 * kind 当前只有 thinking,phase 映射 Anthropic 的 content_block_start / thinking_delta /
 * content_block_stop。
 */
export type LLMStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "content_filter"
  | "refusal";

/**
 * LLM 的一次响应(中性)。stopReason 回答「这轮 API 为什么收笔」,与「业务任务是否
 * 完成」(finish 工具)是两个图层:
 *  - "tool_use"   有工具要执行(finish 也走这条)
 *  - "end_turn"   只回了纯文字、没调任何工具
 *  - "max_tokens" 这轮被截断 → toolCalls 可能是坏的半截,不能拿去 execute
 */
export interface LLMResponse {
  stopReason: LLMStopReason;
  /** 文字部分（可能为空） */
  text: string;
  /** 结构化工具调用（可能为空） */
  toolCalls: ToolCall[];
  /** 本轮的思考定稿块（含签名），Agent 拿去 emit thinking_finished。可能为空 */
  thinkingBlocks?: ThinkingBlock[];
  /** 与 canonical response 一起原子提交的内部 provider 回放状态。 */
  providerReplay?: ProviderReplayState;
  /** Provider 对本次调用实际返回的 token usage 及其有效性。 */
  usage: LLMUsageReport;
}
