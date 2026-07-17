import { describe, it, expect } from "vitest";
import { browserTool } from "../browser.js";
import type { ToolContext } from "../tool.js";
import type { Runtime } from "../../runtime/runtime.js";

/** 构造一个 mock runtime,只实现 runBrowser */
function mockRuntime(
  result: Awaited<ReturnType<Runtime["runBrowser"]>>
): ToolContext {
  return {
    runtime: {
      runBrowser: async () => result,
      create: async () => {},
      kill: async () => {},
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: async () => "",
      writeFile: async () => {},
      runCode: async () => ({ stdout: "", stderr: "", images: [] }),
    },
  };
}

describe("browser 工具", () => {
  it("正常执行返回 stdout", async () => {
    const ctx = mockRuntime({
      stdout: "Page title: Example\n",
      stderr: "",
      exitCode: 0,
    });
    const output = await browserTool.execute(
      { script: "console.log(await page.title())" },
      ctx
    );
    expect(output.isError).toBe(false);
    expect(output.content).toContain("Page title: Example");
  });

  it("exitCode≠0 时 isError=true", async () => {
    const ctx = mockRuntime({
      stdout: "",
      stderr: "Error: Navigation failed",
      exitCode: 1,
    });
    const output = await browserTool.execute(
      { script: "await page.goto('invalid')" },
      ctx
    );
    expect(output.isError).toBe(true);
    expect(output.content).toContain("Navigation failed");
  });

  it("有 screenshots 时输出包含 [截图]", async () => {
    const ctx = mockRuntime({
      stdout: "",
      stderr: "",
      exitCode: 0,
      screenshots: ["iVBOR...1", "iVBOR...2"],
    });
    const output = await browserTool.execute(
      { script: "await page.screenshot()" },
      ctx
    );
    expect(output.isError).toBe(false);
    expect(output.content).toContain("[截图]");
    expect(output.content).toContain("2 张");
  });

  it("无输出时显示 (脚本无输出)", async () => {
    const ctx = mockRuntime({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    const output = await browserTool.execute(
      { script: "// no-op" },
      ctx
    );
    expect(output.isError).toBe(false);
    expect(output.content).toBe("(脚本无输出)");
  });

  it("exitCode≠0 且无输出时显示退出码", async () => {
    const ctx = mockRuntime({
      stdout: "",
      stderr: "",
      exitCode: 127,
    });
    const output = await browserTool.execute(
      { script: "fail" },
      ctx
    );
    expect(output.isError).toBe(true);
    expect(output.content).toContain("127");
  });
});
