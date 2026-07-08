import { describe, it, expect } from "vitest";
import { assembleRunCodeResult } from "./opensandbox-runtime.js";
import type { Execution } from "@alibaba-group/opensandbox";

/**
 * assembleRunCodeResult 纯函数测试。
 *
 * 这是 OpenSandboxRuntime.runCode 的富输出拼装核心:把官方 code-interpreter
 * 包返回的 Execution 映射成 tinyhands 的 RunCodeResult。抽成纯函数后可脱离
 * 真实沙箱/网络,直接喂构造的 Execution 对象测四种输出场景。
 *
 * OutputMessage 需要 { text, timestamp };ExecutionResult 需要 { timestamp, text?, raw? }。
 */

/** 构造 OutputMessage(timestamp 固定 0,测试不关心时间) */
function msg(text: string) {
  return { text, timestamp: 0 };
}

/** 构造最小 Execution 骨架,按需覆盖字段 */
function makeExecution(over: Partial<Execution> = {}): Execution {
  return {
    logs: { stdout: [], stderr: [] },
    result: [],
    ...over,
  };
}

describe("assembleRunCodeResult", () => {
  it("纯文本输出:stdout 合并,无 result/images/error", () => {
    const execution = makeExecution({
      logs: { stdout: [msg("hello "), msg("world\n")], stderr: [] },
    });
    const r = assembleRunCodeResult(execution);
    expect(r.stdout).toBe("hello world\n");
    expect(r.stderr).toBe("");
    expect(r.result).toBeUndefined();
    expect(r.images).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it("表达式返回值:result[].text 拼进 result 字段", () => {
    const execution = makeExecution({
      result: [{ timestamp: 0, text: "42", raw: { "text/plain": "42" } }],
    });
    const r = assembleRunCodeResult(execution);
    expect(r.result).toBe("42");
    expect(r.images).toEqual([]);
  });

  it("matplotlib 图片:result[].raw['image/png'] 收进 images", () => {
    const execution = makeExecution({
      result: [
        {
          timestamp: 0,
          text: "<Figure size 640x480>",
          raw: { "image/png": "iVBORw0KGgoAAAA", "text/plain": "<Figure ...>" },
        },
      ],
    });
    const r = assembleRunCodeResult(execution);
    expect(r.images).toEqual(["iVBORw0KGgoAAAA"]);
    // 图片同一条 result 的 text/plain 也进 result 字段
    expect(r.result).toBe("<Figure size 640x480>");
  });

  it("多个结果混合:多张图片 + 多段文本", () => {
    const execution = makeExecution({
      result: [
        { timestamp: 0, text: "first", raw: { "image/png": "img1" } },
        { timestamp: 0, text: "second", raw: { "image/png": "img2" } },
        { timestamp: 0, text: "no-image", raw: { "text/plain": "no-image" } },
      ],
    });
    const r = assembleRunCodeResult(execution);
    expect(r.images).toEqual(["img1", "img2"]);
    expect(r.result).toBe("first\nsecond\nno-image");
  });

  it("代码报错:error 字段含 name/value 和 traceback", () => {
    const execution = makeExecution({
      logs: { stdout: [], stderr: [] },
      error: {
        name: "ValueError",
        value: "bad input",
        timestamp: 0,
        traceback: ["Traceback (most recent call last):", "ValueError: bad input"],
      },
    });
    const r = assembleRunCodeResult(execution);
    expect(r.error).toBeDefined();
    expect(r.error).toContain("ValueError");
    expect(r.error).toContain("bad input");
    expect(r.error).toContain("Traceback");
  });

  it("stderr 独立于 stdout 合并", () => {
    const execution = makeExecution({
      logs: {
        stdout: [msg("out")],
        stderr: [msg("warn1\n"), msg("warn2\n")],
      },
    });
    const r = assembleRunCodeResult(execution);
    expect(r.stdout).toBe("out");
    expect(r.stderr).toBe("warn1\nwarn2\n");
  });

  it("result 全为空文本时 result 为 undefined 而非空串", () => {
    const execution = makeExecution({
      // 只有图片,没有 text/plain
      result: [{ timestamp: 0, raw: { "image/png": "onlyimg" } }],
    });
    const r = assembleRunCodeResult(execution);
    expect(r.result).toBeUndefined();
    expect(r.images).toEqual(["onlyimg"]);
  });
});
