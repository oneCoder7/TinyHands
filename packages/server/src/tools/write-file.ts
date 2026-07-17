import { z } from "zod/v4";
import type { Tool, ToolContext } from "./tool.js";
import type { ToolOutput } from "../llm/types.js";

/**
 * write_file —— 写入文件内容（覆盖）。
 *
 * 不再自己 fs —— 改走 ctx.runtime.writeFile()，由执行环境决定写到哪。
 */
const WriteFileArgs = z.object({
  path: z.string().describe("要写入的文件路径"),
  content: z.string().describe("写入的内容（覆盖原文件）"),
});

type WriteFileArgsT = z.infer<typeof WriteFileArgs>;

export const writeFileTool: Tool<WriteFileArgsT> = {
  name: "write_file",
  description: "把内容写入指定路径的文件（覆盖原文件）。",
  schema: WriteFileArgs,
  async execute(args: WriteFileArgsT, ctx: ToolContext): Promise<ToolOutput> {
    try {
      await ctx.runtime.writeFile(args.path, args.content);
      return {
        content: `已写入 ${args.path}（${args.content.length} 字符）`,
        isError: false,
      };
    } catch (err) {
      return {
        content: `写入失败：${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
