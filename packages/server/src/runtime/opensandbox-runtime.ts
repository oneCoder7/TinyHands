import { Sandbox } from "@alibaba-group/opensandbox";
import type { Execution } from "@alibaba-group/opensandbox";
import { CodeInterpreter } from "@alibaba-group/opensandbox-code-interpreter";
import type {
  CodeContext,
  SupportedLanguage,
} from "@alibaba-group/opensandbox-code-interpreter";
import type {
  Runtime,
  ExecResult,
  RunCodeResult,
  BrowserResult,
} from "./runtime.js";
import {
  noopLogger,
  type TinyhandsLogger,
} from "../logging/logger.js";

/** 把 OpenSandbox JS SDK 映射到 tinyhands Runtime 接口。 */
export class OpenSandboxRuntime implements Runtime {
  private readonly serverUrl: string;
  private readonly apiKey?: string;
  private readonly image: string;
  private readonly log: TinyhandsLogger;

  private sandbox: Sandbox | null = null;
  private killed = false;

  /**
   * 有状态 kernel:首次 runCode 创建后复用,变量/import/matplotlib figure 跨调用保留。
   */
  private codeInterpreter: CodeInterpreter | null = null;
  private codeContext: CodeContext | null = null;

  constructor(opts: {
    serverUrl: string;
    apiKey?: string;
    image: string;
    logger?: TinyhandsLogger;
  }) {
    this.serverUrl = opts.serverUrl;
    this.apiKey = opts.apiKey;
    this.image = opts.image;
    this.log = (opts.logger ?? noopLogger).child({ module: "opensandbox-runtime" });
  }

  async create(): Promise<void> {
    this.log.info(
      { serverUrl: this.serverUrl, image: this.image },
      "正在创建 OpenSandbox 沙箱"
    );

    const url = new URL(this.serverUrl);
    const protocol = url.protocol === "https:" ? "https" : "http";
    const domain = url.host;

    this.sandbox = await Sandbox.create({
      image: this.image,
      connectionConfig: {
        domain,
        protocol: protocol as "http" | "https",
        apiKey: this.apiKey,
      },
      timeoutSeconds: 600,
    });

    this.log.info(
      { sandboxId: this.sandbox.id, image: this.image },
      "OpenSandbox 沙箱已就绪"
    );
  }

  async exec(
    command: string,
    opts: { timeoutMs?: number } = {}
  ): Promise<ExecResult> {
    this.ensureReady();

    const timeoutSeconds = opts.timeoutMs
      ? Math.ceil(opts.timeoutMs / 1000)
      : 30;

    const execution = await this.sandbox!.commands.run(command, {
      timeoutSeconds,
    });

    return {
      stdout: mergeOutputMessages(execution.logs.stdout),
      stderr: mergeOutputMessages(execution.logs.stderr),
      exitCode: execution.exitCode ?? 1,
    };
  }

  async readFile(path: string): Promise<string> {
    this.ensureReady();
    return this.sandbox!.files.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.ensureReady();
    await this.sandbox!.files.writeFiles([{ path, data: content }]);
  }

  /**
   * 通过官方 code-interpreter 包执行代码,返回富输出。
   * 有状态:同一 Runtime 生命周期内复用 kernel context。
   * 需专用镜像 opensandbox/code-interpreter;缺 /code 端点时落 catch 返回友好错误。
   */
  async runCode(
    code: string,
    opts: { language?: string } = {}
  ): Promise<RunCodeResult> {
    this.ensureReady();
    const language = opts.language ?? "python";

    try {
      const { ci, ctx } = await this.ensureCodeInterpreter(language);
      const execution = await ci.codes.run(code, { context: ctx });
      return assembleRunCodeResult(execution);
    } catch (err) {
      // 网络/协议/kernel 异常 → 友好错误,不抛(与 Local/Docker 一致)
      return {
        stdout: "",
        stderr: "",
        images: [],
        error: `Jupyter kernel 执行失败: ${(err as Error).message}`,
      };
    }
  }

  /** 懒加载并缓存 CodeInterpreter 门面与 context。 */
  private async ensureCodeInterpreter(
    language: string
  ): Promise<{ ci: CodeInterpreter; ctx: CodeContext }> {
    if (!this.codeInterpreter) {
      this.codeInterpreter = await CodeInterpreter.create(this.sandbox!);
    }
    if (!this.codeContext) {
      this.codeContext = await this.codeInterpreter.codes.createContext(
        language as SupportedLanguage
      );
    }
    return { ci: this.codeInterpreter, ctx: this.codeContext };
  }

  /** 通过 OpenSandbox 执行 Playwright 脚本(镜像需预装 playwright+chromium)。 */
  async runBrowser(script: string): Promise<BrowserResult> {
    this.ensureReady();

    const check = await this.exec(
      "node -e \"try{require('playwright');console.log('ok')}catch{process.exit(1)}\""
    );
    if (check.exitCode !== 0) {
      return {
        stdout: "",
        stderr:
          "沙箱内未安装 Playwright,无法执行浏览器脚本。请确保 OpenSandbox 镜像中预装了 playwright 和 chromium。",
        exitCode: 1,
      };
    }

    // 包装脚本
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
    const tmpFile = `/tmp/_tinyhands_browser_${Date.now()}.js`;
    await this.writeFile(tmpFile, wrapper);
    const result = await this.exec(`node ${tmpFile}`, { timeoutMs: 60_000 });
    return { ...result };
  }

  /** 终止沙箱(幂等)。 */
  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;

    // 沙箱销毁后 kernel/context 随之失效,复位缓存
    this.codeInterpreter = null;
    this.codeContext = null;

    if (!this.sandbox) return;
    const sandboxId = this.sandbox.id;

    try {
      await this.sandbox.kill();
    } catch (err) {
      this.log.warn(
        { err, sandboxId },
        "OpenSandbox kill 异常"
      );
    }

    this.log.info({ sandboxId }, "OpenSandbox 沙箱已销毁");
    this.sandbox = null;
  }

  // ---- 内部 ----

  private ensureReady(): void {
    if (this.killed) {
      throw new Error("OpenSandboxRuntime 已 kill,不可再执行");
    }
    if (!this.sandbox) {
      throw new Error("OpenSandboxRuntime 未 create,请先调用 create()");
    }
  }
}

// ---- 工具函数 ----

/** 合并 SDK 的 OutputMessage[] 为单一字符串。 */
function mergeOutputMessages(
  messages: Array<{ text: string }>
): string {
  return messages.map((m) => m.text).join("");
}

/**
 * 把官方包返回的 Execution 拼装成 RunCodeResult。纯函数,可脱离沙箱单测。
 *   logs.stdout/stderr        → stdout/stderr
 *   result[].text             → result(多条换行连接)
 *   result[].raw["image/png"] → images(base64 PNG)
 *   error{name,value,traceback} → error
 */
export function assembleRunCodeResult(execution: Execution): RunCodeResult {
  const stdout = mergeOutputMessages(execution.logs.stdout);
  const stderr = mergeOutputMessages(execution.logs.stderr);

  const result =
    execution.result
      .map((r) => r.text)
      .filter((t): t is string => Boolean(t))
      .join("\n") || undefined;

  const images = execution.result
    .map((r) => r.raw?.["image/png"])
    .filter((v): v is string => typeof v === "string");

  const error = execution.error
    ? `${execution.error.name}: ${execution.error.value}\n` +
      execution.error.traceback.join("\n")
    : undefined;

  return { stdout, stderr, result, images, error };
}
