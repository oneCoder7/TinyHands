import { z } from "zod/v4";
import type { Tool, ToolContext } from "./tool.js";
import type { ToolOutput } from "../llm/types.js";

/**
 * finish —— 显式声明任务完成（结构化收尾）。
 *
 * 特殊点：它的 execute 不"干活"，只是把模型给的结构化结论原样回显。
 * 真正的「结束循环」动作由 Agent 识别 toolCall.name === "finish" 来触发。
 */
const FinishArgs = z.object({
  result: z.string().describe("给用户的最终答复"),
  reason: z.string().optional().describe("完成/停止的理由"),
});

type FinishArgsT = z.infer<typeof FinishArgs>;

export const finishTool: Tool<FinishArgsT> = {
  name: "finish",
  description:
    "当任务已经完成、可以给用户最终答复时调用。result 写给用户的最终答复，reason 可选写完成的理由。",
  schema: FinishArgs,
  // ctx 参数是统一签名要求；finish 不干活、不碰 runtime，故不使用
  async execute(args: FinishArgsT, _ctx: ToolContext): Promise<ToolOutput> {
    return { content: args.result, isError: false };
  },
};
