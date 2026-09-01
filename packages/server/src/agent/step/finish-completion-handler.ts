import type { CompletionHandler, CompletionOutcome } from "./completion-handler.js";
import { ToolCallHandler } from "./tool-call/tool-call-handler.js";

export class FinishCompletionHandler implements CompletionHandler {
  constructor(private readonly toolCalls: ToolCallHandler) {}

  async handle(
    input: Parameters<CompletionHandler["handle"]>[0]
  ): Promise<CompletionOutcome | undefined> {
    const finishCall = input.response.toolCalls.find((call) => call.name === "finish");
    if (!finishCall) {
      if (input.response.toolCalls.length > 0) return undefined;
      return {
        type: "continue",
        contextMessage:
          "如果任务已经完成，请调用 finish 工具给出最终答复；" +
          "如果还需要继续操作，请发起相应的工具调用。",
      };
    }

    const outcome = await this.toolCalls.handleCalls({
      calls: input.response.toolCalls,
      trace: input.trace,
      signal: input.signal,
      selectedToolCallId: finishCall.id,
    });
    if (outcome.type !== "completed") return outcome;

    const result = outcome.results.find(
      (item) => item.toolCallId === finishCall.id
    );
    if (!result) throw new Error("finish ToolCall 未产生配对结果");
    if (result.isError) {
      return {
        type: "continue",
        contextMessage: "finish 调用的参数有误，请检查后重新调用 finish 工具。",
      };
    }
    return { type: "completed", result: result.content };
  }
}
