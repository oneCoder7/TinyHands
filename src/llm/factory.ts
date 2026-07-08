import { AnthropicClient } from "./anthropic-client.js";
import type { LLMClient } from "./llm-client.js";
import type { AppConfig } from "../core/config.js";

/**
 * LLM 客户端工厂 —— 按 provider 造具体实现。
 *
 * 「工厂挨着产品」:只 new llm/ 内部的类,不产生跨层依赖(这也是本项目
 * 里 AnthropicClient 唯一被 new 的地方之一,另一处是 server/agent-session)。
 *
 * provider 接缝在此:将来接入「协议真正不同」的平台(如原生 OpenAI 协议)时,
 * 加一个 case 即可,Agent 与装配代码零改动(它们只认 LLMClient 接口)。
 *
 * fail fast:未知 provider 启动即抛,不拖到首次 chat 才炸。
 */
export function createLLMClient(cfg: AppConfig["llm"]): LLMClient {
  switch (cfg.provider) {
    case "anthropic":
      return new AnthropicClient({
        apiKey: cfg.apiKey,
        baseURL: cfg.baseURL,
        model: cfg.model,
        maxTokens: cfg.maxTokens,
        thinkingBudget: cfg.thinkingBudget,
      });
    default:
      throw new Error(
        `未知的 LLM provider：${cfg.provider}(当前支持：anthropic)`
      );
  }
}
