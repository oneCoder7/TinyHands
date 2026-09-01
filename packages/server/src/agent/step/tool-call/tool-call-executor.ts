import type { ToolCall, ToolOutput } from "../../../llm/types.js";
import type { Tool, ToolContext, ToolRegistry } from "../../../tools/tool.js";

export interface PreparedToolCall {
  call: ToolCall;
  tool: Tool;
  args: unknown;
}

export type PrepareToolCallResult =
  | { type: "prepared"; value: PreparedToolCall }
  | {
      type: "error";
      reason: "unknown_tool" | "invalid_arguments";
      message: string;
    };

/** Tool 的最小调用边界：查找、校验参数、执行。 */
export class ToolCallExecutor {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly context: ToolContext
  ) {}

  prepare(call: ToolCall): PrepareToolCallResult {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { type: "error", reason: "unknown_tool", message: `未知工具：${call.name}` };
    }
    try {
      return {
        type: "prepared",
        value: { call, tool, args: tool.schema.parse(call.args) },
      };
    } catch (error) {
      return {
        type: "error",
        reason: "invalid_arguments",
        message: `工具 ${call.name} 参数不合法：${errorMessage(error)}`,
      };
    }
  }

  execute(call: PreparedToolCall): Promise<ToolOutput> {
    return call.tool.execute(call.args, this.context);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
