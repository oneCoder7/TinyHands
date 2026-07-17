import { z } from "zod/v4";
import type { Tool, ToolContext } from "./tool.js";
import type { ToolOutput } from "../llm/types.js";

/**
 * run_bash —— 执行 shell 命令。
 *
 * 不再自己 exec —— 改走 ctx.runtime.exec()。工具只表达「跑这条命令」的意图，
 *   在哪跑(本机 / 容器)由 runtime 决定。
 *   超时、maxBuffer、非 0 退出等执行细节已下沉到 LocalRuntime。
 *
 * 命令非 0 退出对 agent 是要喂给 LLM 的正常观察(据此决定下一步)，不是程序错误。
 *   故这里把 exitCode≠0 标成 isError 仅供展示，内容仍如实回传。
 */
const RunBashArgs = z.object({
  command: z.string().describe("要执行的 shell 命令"),
});

type RunBashArgsT = z.infer<typeof RunBashArgs>;

export const runBashTool: Tool<RunBashArgsT> = {
  name: "run_bash",
  description: "执行一条 shell 命令，返回它的 stdout / stderr 输出。",
  schema: RunBashArgs,
  async execute(args: RunBashArgsT, ctx: ToolContext): Promise<ToolOutput> {
    const { stdout, stderr, exitCode } = await ctx.runtime.exec(args.command);
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    if (exitCode === 0) {
      return { content: out || "(命令无输出)", isError: false };
    }
    return {
      content: out || `命令以退出码 ${exitCode} 结束`,
      isError: true,
    };
  },
};
