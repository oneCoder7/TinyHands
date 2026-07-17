import { z } from "zod/v4";
import type { Tool, ToolContext } from "./tool.js";
import type { ToolOutput } from "../llm/types.js";

/**
 * run_code —— Code Interpreter,在 Jupyter kernel 中执行代码。
 *
 * 薄壳工具:参数校验 + 调 ctx.runtime.runCode(),跟 run_bash 调
 * ctx.runtime.exec() 完全对称。执行细节下沉到各 Runtime 实现。
 *
 * 与 run_bash 互补:run_bash 跑 shell 命令(一次性,无状态),
 * run_code 跑 Python/JS 等语言代码,有表达式返回值和图片捕获。
 * LLM 按场景选择:数据分析/画图/需要 Python 库 → run_code;
 * 系统操作/文件处理/简单脚本 → run_bash。
 */
const RunCodeArgs = z.object({
  code: z.string().describe("要执行的代码"),
  language: z
    .string()
    .optional()
    .describe("编程语言,默认 python"),
});

type RunCodeArgsT = z.infer<typeof RunCodeArgs>;

export const runCodeTool: Tool<RunCodeArgsT> = {
  name: "run_code",
  description:
    "在 Code Interpreter 中执行 Python 代码。支持数据分析、画图等。" +
    "返回 stdout、表达式返回值和图片(base64)。" +
    "适合需要 Python 库(pandas/matplotlib 等)的场景;" +
    "简单 shell 命令请用 run_bash。",
  schema: RunCodeArgs,

  async execute(args: RunCodeArgsT, ctx: ToolContext): Promise<ToolOutput> {
    const result = await ctx.runtime.runCode(args.code, {
      language: args.language,
    });

    // 组装可读输出
    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.result) parts.push(`[返回值] ${result.result}`);
    if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
    if (result.images.length > 0) {
      parts.push(`[图片] 共 ${result.images.length} 张(base64 已省略)`);
    }

    if (result.error) {
      const out = parts.length > 0 ? parts.join("\n") : result.error;
      return { content: out, isError: true };
    }

    return {
      content: parts.join("\n") || "(代码无输出)",
      isError: false,
    };
  },
};
