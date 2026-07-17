import type { TinyhandsLogger } from "../logging/logger.js";

export type LLMProvider = "anthropic" | "openai";
export type OpenAIApiMode = "responses" | "chat_completions";

export interface AutoCompactConfig {
  enabled: boolean;
  contextWindow: number;
  triggerRatio: number;
  targetRatio: number;
}

interface SharedLLMConfig {
  provider: LLMProvider;
  apiKey: string;
  /** 已解析的 effective endpoint，始终显式传给 provider SDK。 */
  baseURL: string;
  /** 去掉 provider/ 前缀后传给 API 的实际模型名。 */
  model: string;
  maxTokens: number;
  autoCompact: AutoCompactConfig;
}

export type LLMConfig =
  | (SharedLLMConfig & {
      provider: "anthropic";
      thinkingBudget: number;
    })
  | (SharedLLMConfig & {
      provider: "openai";
      apiMode: OpenAIApiMode;
    });

export type TinyhandsRuntimeConfig =
  | { type: "local" }
  | { type: "docker"; image: string }
  | {
      type: "opensandbox";
      serverUrl: string;
      apiKey?: string;
      image: string;
    };

/** framework-neutral Host 的稳定显式配置；不包含 env、端口或进程生命周期。 */
export interface TinyhandsHostOptions {
  workspaceRoot: string;
  llm: LLMConfig;
  maxStep: number;
  runtime: TinyhandsRuntimeConfig;
  /** 省略时使用无输出 logger；Server 不读取 LOG_* 环境变量。 */
  logger?: TinyhandsLogger;
}
