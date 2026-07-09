import { describe, it, expect } from "vitest";
import { LocalRuntime } from "../local-runtime.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("LocalRuntime", () => {
  // 每个测试用临时目录,避免文件残留
  let dir: string;
  let runtime: LocalRuntime;

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "tinyhands-test-"));
    runtime = new LocalRuntime({ cwd: dir });
  }

  function teardown() {
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- exec ----

  describe("exec", () => {
    it("执行成功返回 stdout", async () => {
      setup();
      try {
        const r = await runtime.exec("echo hello");
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim()).toBe("hello");
      } finally {
        teardown();
      }
    });

    it("命令失败返回非 0 exitCode 而非抛异常", async () => {
      setup();
      try {
        const r = await runtime.exec("exit 42");
        expect(r.exitCode).not.toBe(0);
      } finally {
        teardown();
      }
    });
  });

  // ---- readFile / writeFile ----

  describe("readFile / writeFile", () => {
    it("写入后可读回", async () => {
      setup();
      try {
        await runtime.writeFile("test.txt", "hello tinyhands");
        const content = await runtime.readFile("test.txt");
        expect(content).toBe("hello tinyhands");
      } finally {
        teardown();
      }
    });

    it("读不存在的文件抛异常", async () => {
      setup();
      try {
        await expect(runtime.readFile("nonexistent.txt")).rejects.toThrow();
      } finally {
        teardown();
      }
    });
  });

  // ---- runCode ----

  describe("runCode", () => {
    it("python3 可用时正常执行代码", async () => {
      setup();
      try {
        // 先检测 python3 是否可用(CI 环境可能没有)
        const check = await runtime.exec("which python3");
        if (check.exitCode !== 0) {
          // python3 不可用,跳过此测试
          return;
        }

        const r = await runtime.runCode("print('hello from python')");
        expect(r.error).toBeUndefined();
        expect(r.stdout).toContain("hello from python");
        expect(r.images).toEqual([]);
      } finally {
        teardown();
      }
    });

    it("代码执行报错时 error 字段有内容", async () => {
      setup();
      try {
        const check = await runtime.exec("which python3");
        if (check.exitCode !== 0) return;

        const r = await runtime.runCode("raise ValueError('test error')");
        expect(r.error).toBeDefined();
        expect(r.error).toContain("ValueError");
      } finally {
        teardown();
      }
    });

    it("解释器不可用时返回友好错误而非抛异常", async () => {
      setup();
      try {
        // 用一个必然不存在的语言名
        const r = await runtime.runCode("code", { language: "nonexistent_lang_xyz" });
        expect(r.error).toBeDefined();
        expect(r.error).toContain("未安装");
        expect(r.images).toEqual([]);
      } finally {
        teardown();
      }
    });
  });

  // ---- runBrowser ----

  describe("runBrowser", () => {
    it("playwright 不可用时返回友好错误而非抛异常", async () => {
      setup();
      try {
        // 大多数环境没有装 playwright,预期返回友好错误
        const r = await runtime.runBrowser("await page.goto('http://example.com')");
        // 不论 playwright 是否可用,都不应该抛异常
        if (r.exitCode !== 0) {
          expect(r.stderr).toContain("Playwright");
        }
      } finally {
        teardown();
      }
    });
  });
});
