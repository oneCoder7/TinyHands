import type { ExecResult } from "./runtime.js";
import {
  noopLogger,
  type TinyhandsLogger,
} from "../logging/logger.js";

/**
 * ExecdClient —— execd 协议的宿主侧 HTTP 客户端。
 *
 * DockerRuntime(及未来 RemoteRuntime)容器内跑同一个 execd server,宿主侧共用这个
 * client;差异只在容器怎么创建,通信协议一致。全 POST,4 端点:
 *   /exec 执行命令 · /read-file 读 · /write-file 覆盖写 · /health 就绪探针
 * 零额外依赖:用 Node 内置全局 fetch。
 */
export class ExecdClient {
  private readonly baseUrl: string;
  private readonly log: TinyhandsLogger;

  constructor(opts: { host: string; port: number; logger?: TinyhandsLogger }) {
    this.baseUrl = `http://${opts.host}:${opts.port}`;
    this.log = (opts.logger ?? noopLogger).child({ module: "execd-client" });
  }

  // ---- 执行面(Runtime 方法对应) ----

  async exec(
    command: string,
    opts: { timeoutMs?: number } = {}
  ): Promise<ExecResult> {
    const body = { command, timeoutMs: opts.timeoutMs };
    const data = await this.post<ExecResult>("/exec", body);
    return {
      stdout: data.stdout ?? "",
      stderr: data.stderr ?? "",
      exitCode: data.exitCode ?? 1,
    };
  }

  async readFile(path: string): Promise<string> {
    const data = await this.post<{ content: string }>("/read-file", { path });
    return data.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.post<{ ok: boolean }>("/write-file", { path, content });
  }

  // ---- 就绪探针 ----

  /**
   * 检查 execd 是否就绪。超时或网络不通返回 false(不抛异常)。
   */
  async isReady(): Promise<boolean> {
    try {
      const data = await this.post<{ status: string }>("/health", {}, 2000);
      return data.status === "ok";
    } catch {
      return false;
    }
  }

  /**
   * 轮询等待 execd 就绪。create 流程使用:容器启动后 execd 需要几百毫秒
   * 才监听端口,此方法重试直到 ready 或超时。
   *
   * @param timeoutMs 总超时(默认 30s)
   * @param intervalMs 轮询间隔(默认 500ms)
   */
  async waitReady(timeoutMs = 30_000, intervalMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isReady()) {
        this.log.debug({ baseUrl: this.baseUrl }, "execd ready");
        return;
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `execd 未在 ${timeoutMs}ms 内就绪 (${this.baseUrl})`
    );
  }

  // ---- 内部 HTTP 通信 ----

  /**
   * 统一 POST 请求:全 POST 协议,请求/响应都是 JSON。
   * 非 2xx 响应抛 Error(message 含 server 返回的 error 字段)。
   */
  private async post<T>(
    endpoint: string,
    body: unknown,
    timeoutMs = 30_000
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = (await resp.json()) as T & { error?: string };

    if (!resp.ok) {
      const msg = data.error ?? `execd ${endpoint} 返回 ${resp.status}`;
      throw new Error(msg);
    }

    return data;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
