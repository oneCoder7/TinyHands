import { describe, it, expect } from "vitest";
import { runCodeTool } from "../run-code.js";
import type { ToolContext } from "../tool.js";
import type { Runtime } from "../../runtime/runtime.js";

/** 构造一个 mock runtime,只实现 runCode */
function mockRuntime(
  result: Awaited<ReturnType<Runtime["runCode"]>>
): ToolContext {
  return {
    runtime: {
      runCode: async () => result,
      // 其余方法不会被 run_code 工具调用,填 stub
      create: async () => {},
      kill: async () => {},
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: async () => "",
      writeFile: async () => {},
      runBrowser: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    },
  };
}

describe("run_code 工具", () => {
  it("正常执行返回 stdout", async () => {
    const ctx = mockRuntime({
      stdout: "hello world\n",
      stderr: "",
      images: [],
    });
    const output = await runCodeTool.execute({ code: "print('hello world')" }, ctx);
    expect(output.isError).toBe(false);
    expect(output.content).toContain("hello world");
  });

  it("有 result 时输出包含 [返回值]", async () => {
    const ctx = mockRuntime({
      stdout: "",
      stderr: "",
      result: "42",
      images: [],
    });
    const output = await runCodeTool.execute({ code: "1+1" }, ctx);
    expect(output.isError).toBe(false);
    expect(output.content).toContain("[返回值]");
    expect(output.content).toContain("42");
  });

  it("有 images 时输出包含 [图片]", async () => {
    const ctx = mockRuntime({
      stdout: "",
      stderr: "",
      images: ["iVBOR...base64..."],
    });
    const output = await runCodeTool.execute({ code: "plt.show()" }, ctx);
    expect(output.isError).toBe(false);
    expect(output.content).toContain("[图片]");
    expect(output.content).toContain("1 张");
  });

  it("error 时 isError=true", async () => {
    const ctx = mockRuntime({
      stdout: "",
      stderr: "NameError: name 'foo' is not defined",
      images: [],
      error: "NameError: name 'foo' is not defined",
    });
    const output = await runCodeTool.execute({ code: "foo" }, ctx);
    expect(output.isError).toBe(true);
    expect(output.content).toContain("NameError");
  });

  it("无输出时显示 (代码无输出)", async () => {
    const ctx = mockRuntime({
      stdout: "",
      stderr: "",
      images: [],
    });
    const output = await runCodeTool.execute({ code: "x = 1" }, ctx);
    expect(output.isError).toBe(false);
    expect(output.content).toBe("(代码无输出)");
  });

  it("传 language 参数透传给 runtime", async () => {
    let captured: { language?: string } | undefined;
    const ctx: ToolContext = {
      runtime: {
        runCode: async (_code, opts) => {
          captured = opts;
          return { stdout: "", stderr: "", images: [] };
        },
        create: async () => {},
        kill: async () => {},
        exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        readFile: async () => "",
        writeFile: async () => {},
        runBrowser: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      },
    };
    await runCodeTool.execute({ code: "1", language: "javascript" }, ctx);
    expect(captured?.language).toBe("javascript");
  });
});
