import Docker from "dockerode";
import type { Runtime, ExecResult, RunCodeResult, BrowserResult } from "./runtime.js";
import { ExecdClient } from "./execd-client.js";
import { logger } from "../core/logger.js";

const log = logger.child({ module: "docker-runtime" });

/** 容器标签:孤儿容器清理依据 */
const LABEL_MANAGED = "tinyhands.managed";
const LABEL_CONVERSATION = "tinyhands.conversation";

/** execd 监听端口(容器内固定) */
const EXECD_PORT = 44772;

/**
 * DockerRuntime —— 在 Docker 容器内执行命令/读写文件。
 * 控制面(dockerode):创建/启动/停止/删除容器。执行面(ExecdClient):HTTP 到容器内
 * execd server。create 之前或 kill 之后调 exec/readFile/writeFile 会抛 Error(fail fast)。
 */
export class DockerRuntime implements Runtime {
  private readonly docker: Docker;
  private readonly image: string;
  private readonly conversationId: string;

  private container: Docker.Container | null = null;
  private client: ExecdClient | null = null;
  private killed = false;

  constructor(opts: {
    image: string;
    conversationId: string;
  }) {
    this.docker = new Docker(); // 默认 /var/run/docker.sock
    this.image = opts.image;
    this.conversationId = opts.conversationId;
  }

  /**
   * create = 创建容器 + 启动 + 等 execd 就绪。
   * HostPort:0 → Docker 自动分配宿主端口,避免多会话端口冲突。文件全在容器内,
   * 不做 bind mount。
   */
  async create(): Promise<void> {
    log.info(
      { conversationId: this.conversationId, image: this.image },
      "正在创建 sandbox 容器"
    );

    const container = await this.docker.createContainer({
      Image: this.image,
      Labels: {
        [LABEL_MANAGED]: "true",
        [LABEL_CONVERSATION]: this.conversationId,
      },
      ExposedPorts: { [`${EXECD_PORT}/tcp`]: {} },
      HostConfig: {
        PortBindings: {
          [`${EXECD_PORT}/tcp`]: [{ HostPort: "0" }], // 动态端口
        },
      },
    });
    this.container = container;

    await container.start();

    // 拿动态分配的宿主端口
    const info = await container.inspect();
    const portBindings =
      info.NetworkSettings.Ports[`${EXECD_PORT}/tcp`];
    const binding = portBindings?.[0];
    if (!binding?.HostPort) {
      throw new Error("无法获取容器映射端口");
    }
    const hostPort = Number(binding.HostPort);

    log.info(
      {
        conversationId: this.conversationId,
        containerId: container.id.slice(0, 12),
        hostPort,
      },
      "容器已启动,等待 execd 就绪"
    );

    // 建立 ExecdClient,轮询 health 探针
    this.client = new ExecdClient({ host: "127.0.0.1", port: hostPort });
    await this.client.waitReady();

    log.info(
      { conversationId: this.conversationId, hostPort },
      "sandbox 容器就绪"
    );
  }

  async exec(
    command: string,
    opts: { timeoutMs?: number } = {}
  ): Promise<ExecResult> {
    this.ensureReady();
    return this.client!.exec(command, opts);
  }

  async readFile(path: string): Promise<string> {
    this.ensureReady();
    return this.client!.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.ensureReady();
    return this.client!.writeFile(path, content);
  }

  /**
   * 容器内 python3 -c 执行代码,依赖镜像预装 Python。图片捕获需容器内 Jupyter
   * kernel(未来增强),当前返回空数组。python3 不可用则返回友好错误。
   */
  async runCode(
    code: string,
    opts: { language?: string } = {}
  ): Promise<RunCodeResult> {
    this.ensureReady();
    const lang = opts.language ?? "python";
    const interpreter = lang === "python" ? "python3" : lang;

    const check = await this.client!.exec(`which ${interpreter}`);
    if (check.exitCode !== 0) {
      return {
        stdout: "",
        stderr: "",
        images: [],
        error: `容器内未安装 ${interpreter},无法执行 ${lang} 代码。请确保 Docker 镜像中预装了 ${interpreter},或改用 run_bash。`,
      };
    }

    // 代码写入临时文件再执行(避免 shell 转义问题)
    const tmpFile = `/tmp/_tinyhands_code_${Date.now()}.py`;
    await this.client!.writeFile(tmpFile, code);
    const result = await this.client!.exec(
      `${interpreter} ${tmpFile}`,
      { timeoutMs: 60_000 }
    );

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      images: [],
      error: result.exitCode !== 0 ? (result.stderr || `exit code ${result.exitCode}`) : undefined,
    };
  }

  /** 容器内 node 执行 Playwright 脚本,依赖镜像预装 playwright+chromium。 */
  async runBrowser(script: string): Promise<BrowserResult> {
    this.ensureReady();

    const check = await this.client!.exec(
      "node -e \"try{require('playwright');console.log('ok')}catch{process.exit(1)}\""
    );
    if (check.exitCode !== 0) {
      return {
        stdout: "",
        stderr:
          "容器内未安装 Playwright,无法执行浏览器脚本。请确保 Docker 镜像中预装了 playwright 和 chromium。",
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
    const tmpFile = `/tmp/_tinyhands_browser_${Date.now()}.js`;
    await this.client!.writeFile(tmpFile, wrapper);
    const result = await this.client!.exec(`node ${tmpFile}`, {
      timeoutMs: 60_000,
    });
    return { ...result };
  }

  /**
   * kill = 停止 + 删除容器。幂等。
   * stop 可能因容器已停而报错(304),catch 后继续 remove。
   */
  async kill(): Promise<void> {
    if (this.killed) return;
    this.killed = true;

    if (!this.container) return;
    const shortId = this.container.id.slice(0, 12);

    try {
      await this.container.stop({ t: 5 }); // 5s 优雅停止
    } catch (err: unknown) {
      // 容器可能已停(304 Not Modified / 已退出),不算异常
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode !== 304) {
        log.warn(
          { err, conversationId: this.conversationId, containerId: shortId },
          "容器 stop 异常,继续 remove"
        );
      }
    }

    try {
      await this.container.remove({ force: true });
    } catch (err) {
      log.warn(
        { err, conversationId: this.conversationId, containerId: shortId },
        "容器 remove 异常"
      );
    }

    log.info(
      { conversationId: this.conversationId, containerId: shortId },
      "sandbox 容器已销毁"
    );
    this.container = null;
    this.client = null;
  }

  // ---- 内部 ----

  private ensureReady(): void {
    if (this.killed) {
      throw new Error("DockerRuntime 已 kill,不可再执行");
    }
    if (!this.client) {
      throw new Error("DockerRuntime 未 create,请先调用 create()");
    }
  }
}

// ---- 孤儿容器清理 ----

/**
 * 清理标记为 tinyhands.managed=true 的残留容器。进程启动时清理上次遗留、退出时
 * graceful shutdown。不抛异常:清理失败只记日志。
 */
export async function cleanupOrphanContainers(): Promise<void> {
  try {
    const docker = new Docker();
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=true`] },
    });

    if (containers.length === 0) return;

    log.info(
      { count: containers.length },
      "发现残留 sandbox 容器,正在清理"
    );

    for (const info of containers) {
      try {
        const c = docker.getContainer(info.Id);
        await c.remove({ force: true });
        log.info(
          { containerId: info.Id.slice(0, 12), names: info.Names },
          "已清理残留容器"
        );
      } catch (err) {
        log.warn(
          { err, containerId: info.Id.slice(0, 12) },
          "清理残留容器失败"
        );
      }
    }
  } catch (err) {
    // Docker daemon 不可达时不应阻塞启动(runtime=local 也会走到这里)
    log.warn({ err }, "孤儿容器清理失败(Docker 可能不可用)");
  }
}
