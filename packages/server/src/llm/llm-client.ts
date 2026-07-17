import type {
  LLMCallIdentity,
  LLMResponse,
  Message,
  Delta,
} from "./types.js";
import type { Tool } from "../tools/tool.js";

/** chat 的可选项 —— 流式回调、中止信号和真正跨 provider 等价的请求覆盖项。 */
export interface ChatOptions {
  /**
   * 流式增量回调。传了就开启流式，token/思考边界通过它实时推出。
   *   注意 onDelta 只做「传输」，与「持久化」正交 —— Delta 不入真相源，
   *   由上层(Agent→Conversation)决定要不要广播给订阅者。
   */
  onDelta?: (d: Delta) => void;
  /**
   * 中止信号。abort 后本次 chat 以异常终止(错误类型由实现决定)。调用方识别打断
   * 只看 signal.aborted,不依赖任何实现方的错误类型。AbortSignal 是平台标准类型。
   */
  signal?: AbortSignal;
  /** 本次调用追加的系统上下文；adapter 映射到各协议的系统指令位置。 */
  systemContext?: string[];
  /** 本次调用的输出 token 上限；省略时使用客户端配置值。 */
  maxTokens?: number;
}

/**
 * LLM 客户端接口 —— 依赖倒置的核心。
 *
 * 业务代码(Agent)只依赖这个接口,不知道背后是 Anthropic 还是别的渠道。默认实现
 * AnthropicClient 是唯一 import @anthropic-ai/sdk 的地方。方法签名只用中性类型
 * (Message / Tool / LLMResponse / Delta),不漏出任何 Anthropic 专属类型。
 */
export interface LLMClient {
  /** 固定的 provider/model/API 协议身份，供调用前持久化追踪。 */
  readonly identity: LLMCallIdentity;

  /**
   * 发起一轮对话。
   * @param messages 完整历史（每轮全量带上）
   * @param tools 本轮可用的工具集
   * @param opts 可选项；传 onDelta 即开启流式
   * @returns 中性 LLMResponse（含 stopReason / text / toolCalls / thinkingBlocks）
   */
  chat(messages: Message[], tools: Tool[], opts?: ChatOptions): Promise<LLMResponse>;
}
