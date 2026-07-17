import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AutoCompactConfig,
  LLMConfig,
  LLMProvider,
  OpenAIApiMode,
  TinyhandsHostOptions,
  TinyhandsRuntimeConfig,
} from "@tinyhands/server";

export interface StandaloneConfig {
  port: number;
  host: Omit<TinyhandsHostOptions, "logger">;
}

const DEFAULT_BASE_URL: Record<LLMProvider, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

/** 显式解析 standalone 进程环境；不缓存，Server library 不依赖此模块。 */
export function readStandaloneConfig(
  env: NodeJS.ProcessEnv = process.env
): StandaloneConfig {
  const modelRef = env.LLM_MODEL?.trim();
  if (!modelRef) {
    throw new Error(
      "缺少 LLM_MODEL：请按 provider/model 格式设置模型(见 .env.example)"
    );
  }
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) {
    throw new Error(`LLM_MODEL 格式错误：${modelRef}(应为 provider/model)`);
  }
  const provider = modelRef.slice(0, slash);
  const model = modelRef.slice(slash + 1).trim();
  if (provider !== "anthropic" && provider !== "openai") {
    throw new Error(
      `未知的 LLM provider：${provider}(当前支持：anthropic, openai)`
    );
  }
  if (!model) {
    throw new Error(`LLM_MODEL 格式错误：${modelRef}(model 不能为空)`);
  }

  const apiKey = (
    provider === "anthropic"
      ? env.ANTHROPIC_AUTH_TOKEN ?? env.LLM_API_KEY
      : env.OPENAI_API_KEY ?? env.LLM_API_KEY
  )?.trim();
  if (!apiKey) {
    throw new Error(
      `缺少 ${provider} API key：请设置 LLM_API_KEY` +
        (provider === "anthropic"
          ? " 或 ANTHROPIC_AUTH_TOKEN"
          : " 或 OPENAI_API_KEY")
    );
  }

  const baseURL = parseBaseURL(env.LLM_BASE_URL, DEFAULT_BASE_URL[provider]);
  const maxTokens = parseInteger(env.LLM_MAX_TOKENS, 8192, "LLM_MAX_TOKENS", 1);
  const autoCompact = parseAutoCompactConfig(env, maxTokens);

  const llm: LLMConfig =
    provider === "anthropic"
      ? {
          provider,
          apiKey,
          baseURL,
          model,
          maxTokens,
          autoCompact,
          thinkingBudget: parseInteger(
            env.LLM_THINKING_BUDGET,
            2048,
            "LLM_THINKING_BUDGET",
            0
          ),
        }
      : {
          provider,
          apiKey,
          baseURL,
          model,
          maxTokens,
          autoCompact,
          apiMode: parseOpenAIApiMode(env.LLM_OPENAI_API_MODE),
        };

  const runtimeType = ["docker", "opensandbox"].includes(env.RUNTIME ?? "")
    ? (env.RUNTIME as "docker" | "opensandbox")
    : "local";
  const runtime: TinyhandsRuntimeConfig =
    runtimeType === "docker"
      ? {
          type: "docker",
          image: env.DOCKER_IMAGE ?? "tinyhands-sandbox:latest",
        }
      : runtimeType === "opensandbox"
        ? {
            type: "opensandbox",
            serverUrl: env.OPENSANDBOX_SERVER_URL ?? "http://localhost:8080",
            ...(env.OPENSANDBOX_API_KEY
              ? { apiKey: env.OPENSANDBOX_API_KEY }
              : {}),
            image:
              env.OPENSANDBOX_IMAGE ?? "opensandbox/code-interpreter:v1.1.0",
          }
        : { type: "local" };

  return {
    port: Number(env.PORT ?? 8787),
    host: {
      workspaceRoot: join(env.TINYHANDS_HOME ?? homedir(), "workspace"),
      llm,
      maxStep: Number(env.MAX_STEP ?? 10),
      runtime,
    },
  };
}

function parseAutoCompactConfig(
  env: NodeJS.ProcessEnv,
  maxOutputTokens: number
): AutoCompactConfig {
  const enabled = parseBoolean(
    env.LLM_AUTO_COMPACT_ENABLED,
    true,
    "LLM_AUTO_COMPACT_ENABLED"
  );
  const contextWindow = parseInteger(
    env.LLM_CONTEXT_WINDOW,
    20_000,
    "LLM_CONTEXT_WINDOW",
    1
  );
  const triggerRatio = parseRatio(
    env.LLM_AUTO_COMPACT_TRIGGER_RATIO,
    0.8,
    "LLM_AUTO_COMPACT_TRIGGER_RATIO"
  );
  const targetRatio = parseRatio(
    env.LLM_AUTO_COMPACT_TARGET_RATIO,
    0.5,
    "LLM_AUTO_COMPACT_TARGET_RATIO"
  );
  const safetyMargin = Math.max(1024, Math.ceil(contextWindow * 0.05));
  if (contextWindow - maxOutputTokens - safetyMargin <= 0) {
    throw new Error(
      "LLM_CONTEXT_WINDOW 必须大于 LLM_MAX_TOKENS 与 auto-compact 安全余量之和"
    );
  }
  if (targetRatio >= triggerRatio) {
    throw new Error(
      "LLM_AUTO_COMPACT_TARGET_RATIO 必须小于 LLM_AUTO_COMPACT_TRIGGER_RATIO"
    );
  }
  return { enabled, contextWindow, triggerRatio, targetRatio };
}

function parseOpenAIApiMode(raw: string | undefined): OpenAIApiMode {
  const mode = raw?.trim() || "responses";
  if (mode !== "responses" && mode !== "chat_completions") {
    throw new Error(
      `未知的 LLM_OPENAI_API_MODE：${mode}(当前支持：responses, chat_completions)`
    );
  }
  return mode;
}

function parseBaseURL(raw: string | undefined, fallback: string): string {
  const value = raw?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`LLM_BASE_URL 非法：${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`LLM_BASE_URL 只支持 http/https：${value}`);
  }
  return value;
}

function parseBoolean(
  raw: string | undefined,
  fallback: boolean,
  name: string
): boolean {
  const value = raw?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function parseRatio(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} 必须是 0 与 1 之间的数字`);
  }
  return value;
}

function parseInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
  minimum: number
): number {
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} 必须是大于等于 ${minimum} 的安全整数`);
  }
  return value;
}
