import { z } from "zod/v4";
import type { Tool, ToolContext } from "./tool.js";
import type { ToolOutput } from "../llm/types.js";

/**
 * browser —— 在浏览器中执行 Playwright 脚本。
 *
 * 薄壳工具:参数校验 + 调 ctx.runtime.runBrowser(),跟 run_bash 调
 * ctx.runtime.exec() 完全对称。执行细节下沉到各 Runtime 实现。
 *
 * 脚本在 Playwright 环境中运行,page 对象已就绪。
 * 可用于网页抓取、表单填写、截图、UI 测试等。
 */
const BrowserArgs = z.object({
  script: z
    .string()
    .describe("Playwright 脚本(JavaScript)。page 对象已就绪,可直接使用。"),
});

type BrowserArgsT = z.infer<typeof BrowserArgs>;

export const browserTool: Tool<BrowserArgsT> = {
  name: "browser",
  description:
    "在浏览器中执行 Playwright 脚本。可用于网页抓取、表单填写、截图、UI 测试等。" +
    "脚本在 Playwright 环境中运行,page 对象已就绪。",
  schema: BrowserArgs,

  async execute(args: BrowserArgsT, ctx: ToolContext): Promise<ToolOutput> {
    const result = await ctx.runtime.runBrowser(args.script);

    const parts: string[] = [];
    if (result.stdout) parts.push(result.stdout);
    if (result.stderr) parts.push(`[stderr] ${result.stderr}`);
    if (result.screenshots && result.screenshots.length > 0) {
      parts.push(
        `[截图] 共 ${result.screenshots.length} 张(base64 已省略)`
      );
    }

    if (result.exitCode !== 0) {
      const out =
        parts.length > 0 ? parts.join("\n") : `脚本以退出码 ${result.exitCode} 结束`;
      return { content: out, isError: true };
    }

    return {
      content: parts.join("\n") || "(脚本无输出)",
      isError: false,
    };
  },
};
