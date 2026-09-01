import type { LLMResponse } from "../../llm/types.js";
import type { ToolTrace } from "./tool-call/tool-call-handler.js";

export type CompletionOutcome =
  | { type: "continue"; contextMessage: string }
  | { type: "completed"; result: string }
  | { type: "suspended" }
  | { type: "interrupted" };

export interface CompletionHandler {
  handle(input: {
    response: Readonly<LLMResponse>;
    trace: ToolTrace;
    signal?: AbortSignal;
  }): Promise<CompletionOutcome | undefined>;
}
