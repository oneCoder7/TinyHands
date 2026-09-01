import { toJSONSchema } from "zod/v4";
import type { Message } from "../../llm/types.js";
import type { AutoCompactConfig } from "../../server/options.js";
import type { Tool } from "../../tools/tool.js";

export interface CompactionBudget {
  safetyMargin: number;
  usableInputBudget: number;
  triggerTokens: number;
  targetTokens: number;
  summaryMaxTokens: number;
}

export function calculateCompactionBudget(
  config: AutoCompactConfig,
  maxOutputTokens: number
): CompactionBudget {
  const safetyMargin = Math.max(1024, Math.ceil(config.contextWindow * 0.05));
  const usableInputBudget = config.contextWindow - maxOutputTokens - safetyMargin;
  return {
    safetyMargin,
    usableInputBudget,
    triggerTokens: Math.floor(usableInputBudget * config.triggerRatio),
    targetTokens: Math.floor(usableInputBudget * config.targetRatio),
    summaryMaxTokens: Math.min(2048, Math.max(512, Math.floor(usableInputBudget * 0.1))),
  };
}

/** 未知 tokenizer 下的保守估算；完整覆盖 system、tools、messages 和 replay。 */
export function estimateCanonicalInputTokens(
  messages: Message[],
  systemContext: string[],
  tools: Tool[]
): number {
  const canonical = {
    systemContext,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: toJSONSchema(tool.schema),
    })),
    messages,
  };
  return Math.ceil(Buffer.byteLength(JSON.stringify(canonical), "utf8") / 3);
}
