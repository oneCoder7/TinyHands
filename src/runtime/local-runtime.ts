import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Runtime, ExecResult, RunCodeResult, BrowserResult } from "./runtime.js";

const execAsync = promisify(exec);

/**
 * shell 转义:将任意字符串包为单引号参数,防注入。
 * 单引号内的单引号用 '\'' 转义(结束引用→转义单引号→重新引用)。
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * LocalRuntime —— 在本机进程直接执行。零隔离:命令裸跑在宿主机,只是套了 Runtime
 * 接口(隔离由 DockerRuntime 提供)。cwd 是本 runtime 的工作目录,每个会话一个实例
 * 绑定各自目录,多会话互不踩文件。异步纪律:子进程用 promisify(exec),文件用
 * fs/promises,绝不用同步 API 阻塞事件循环。
 */
export class LocalRuntime implements Runtime {
  private readonly cwd: string;

  constructor(opts: { cwd?: string } = {}) {
    this.cwd = opts.cwd ?? process.cwd();
  }

  /** no-op:本地执行无资源需创建 */
  async create(): Promise<void> {}

  /** no-op:本地执行无资源需释放 */
  async kill(): Promise<void> {}

  async exec(
    command: string,
    opts: { timeoutMs?: number } = {}
  ): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.cwd,
        timeout: opts.timeoutMs ?? 30_000, // 30s 超时兜底,防命令挂死拖住循环
        maxBuffer: 1024 * 1024, // 1MB 输出上限
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      // 非 0 退出 / 超时 / maxBuffer 超限都落这里。对 agent 而言「命令失败」是要喂回
      // LLM 的正常观察,不是程序错误,故不 throw,如实带回 stdout/stderr/exitCode。
      const e = err as {
        stdout?: string;
        stderr?: string;
        code?: number;
        message: string;
      };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message,
        exitCode: typeof e.code === "number" ? e.code : 1,
      };
    }
  }

  async readFile(path: string): Promise<string> {
    // 相对路径按 cwd 解析(绝对路径原样)
    return readFile(resolve(this.cwd, path), "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    await writeFile(resolve(this.cwd, path), content, "utf-8");
  }

  /**
   * 宿主机解释器直接执行代码。图片捕获在 local 模式不支持(需容器内 Jupyter kernel
   * 的 rich output 协议),返回空数组。解释器不可用只返回错误给 LLM,不抛异常。
   */
  async runCode(
    code: string,
    opts: { language?: string } = {}
  ): Promise<RunCodeResult> {
    const lang = opts.language ?? "python";
    const interpreter = lang === "python" ? "python3" : lang;
    const check = await this.exec(`which ${interpreter}`);
    if (check.exitCode !== 0) {
      return {
        stdout: "",
        stderr: "",
        images: [],
        error: `当前环境未安装 ${interpreter},无法执行 ${lang} 代码。请改用 run_bash 执行 shell 命令,或在支持 Code Interpreter 的 Runtime(Docker/OpenSandbox)中运行。`,
      };
    }

    // 解释器 -c 直接执行(避免临时文件)
    try {
      const { stdout, stderr } = await execAsync(
        `${interpreter} -c ${shellEscape(code)}`,
        {
          cwd: this.cwd,
          timeout: 60_000,
          maxBuffer: 5 * 1024 * 1024, // 5MB(数据分析输出可能较大)
        }
      );
      return { stdout, stderr, images: [] };
    } catch (err) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        message: string;
      };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        images: [],
        error: e.stderr || e.message,
      };
    }
  }

  /**
   * node 执行 Playwright 脚本。Playwright 不可用只返回错误给 LLM,不抛异常。
   */
  async runBrowser(script: string): Promise<BrowserResult> {
    const check = await this.exec(
      "node -e \"try{require('playwright');console.log('ok')}catch{process.exit(1)}\""
    );
    if (check.exitCode !== 0) {
      return {
        stdout: "",
        stderr:
          "当前环境未安装 Playwright,无法执行浏览器脚本。请改用支持 Browser 的 Runtime(Docker/OpenSandbox)。",
        exitCode: 1,
      };
    }

    // 包装脚本:注入 playwright launch + page
    const wrapper = `
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    ${script}
  } finally {
    await browser.close();
  }
})();
`;
    const result = await this.exec(`node -e ${shellEscape(wrapper)}`, {
      timeoutMs: 60_000,
    });
    return { ...result };
  }
}
