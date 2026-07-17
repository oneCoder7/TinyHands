import { z } from "zod/v4";
import type { Tool, ToolContext } from "./tool.js";
import type { ToolOutput } from "../llm/types.js";

/**
 * read_file —— 读取文件内容。
 *
 * 不再自己 fs —— 改走 ctx.runtime.readFile()。在容器里执行时文件读写也进容器，
 *   与命令看到同一个文件系统，不分裂。
 */
const ReadFileArgs = z.object({
  path: z.string().describe("要读取的文件路径"),
});

type ReadFileArgsT = z.infer<typeof ReadFileArgs>;

export const readFileTool: Tool<ReadFileArgsT> = {
  name: "read_file",
  description: "读取指定路径的文件内容并返回。",
  schema: ReadFileArgs,
  async execute(args: ReadFileArgsT, ctx: ToolContext): Promise<ToolOutput> {
    try {
      const content = await ctx.runtime.readFile(args.path);
      return { content, isError: false };
    } catch (err) {
      return {
        content: `读取失败：${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
