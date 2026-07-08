/**
 * 全局配置 —— 进程级单例,启动时从环境变量读一次并冻结(只读)。
 *
 * 这里只放「进程级」配置(端口/LLM 凭据/工作目录根),全进程一份。「会话级」状态
 * (conversationId、workspaceDir)在创建会话时逐个注入,不经全局可变量,不会串台。
 * 日志配置(LOG_LEVEL/LOG_FORMAT)不在此:logger 须先于 config 可用,故自读 env。
 */

export interface AppConfig {
  /** WS 服务端口 */
  port: number;
  /** 会话工作目录的根:每个 conversation 在其下有专属子目录 {convId}/ */
  workspaceRoot: string;
  /** LLM 相关 */
  llm: {
    /**
     * LLM provider 选择(LLM_PROVIDER,默认 "anthropic")。团队网关的模型都走
     * Anthropic 风格协议,切换模型只改 LLM_MODEL;此字段为将来接入协议不同的平台
     * (如原生 OpenAI 协议)预留接缝。
     */
    provider: string;
    apiKey: string;
    baseURL: string;
    model: string;
    maxTokens: number;
    thinkingBudget: number;
  };
  /** agent 循环上限 */
  maxStep: number;
  /**
   * 执行环境选择(RUNTIME,默认 "local")。全进程统一:所有会话用同一种 runtime。
   */
  runtime: "local" | "docker" | "opensandbox";
  /** Docker runtime 配置(仅 runtime="docker" 时使用) */
  docker: {
    /** sandbox 容器镜像(DOCKER_IMAGE,默认 "tinyhands-sandbox:latest") */
    image: string;
  };
  /** OpenSandbox runtime 配置(仅 runtime="opensandbox" 时使用) */
  opensandbox: {
    /** 平台地址(OPENSANDBOX_SERVER_URL,默认 "http://localhost:8080") */
    serverUrl: string;
    /** API Key(OPENSANDBOX_API_KEY,可选) */
    apiKey?: string;
    /** 沙箱镜像(OPENSANDBOX_IMAGE,默认 code-interpreter 专用镜像,内置 Jupyter kernel) */
    image: string;
  };
}

function readConfig(): AppConfig {
  const apiKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.LLM_API_KEY;
  if (!apiKey) {
    // 配置缺失是启动即失败的问题,尽早暴露(fail fast),不拖到运行时
    throw new Error(
      "缺少 API key：请设置环境变量 ANTHROPIC_AUTH_TOKEN(见 .env.example)"
    );
  }

  // baseURL / model 是环境专属值,无内置默认:缺失即 fail fast,避免把某一方的
  // 网关地址与模型名硬编码进代码库。
  const baseURL = process.env.LLM_BASE_URL;
  if (!baseURL) {
    throw new Error("缺少 LLM_BASE_URL：请设置 LLM 网关地址(见 .env.example)");
  }
  const model = process.env.LLM_MODEL;
  if (!model) {
    throw new Error("缺少 LLM_MODEL：请设置模型名(见 .env.example)");
  }

  return {
    port: Number(process.env.PORT ?? 8787),
    workspaceRoot: process.env.WORKSPACE_ROOT ?? `${process.cwd()}/workspaces`,
    llm: {
      provider: process.env.LLM_PROVIDER ?? "anthropic",
      apiKey,
      baseURL,
      model,
      maxTokens: Number(process.env.LLM_MAX_TOKENS ?? 8192),
      thinkingBudget: Number(process.env.LLM_THINKING_BUDGET ?? 2048),
    },
    maxStep: Number(process.env.MAX_STEP ?? 10),
    runtime: (["docker", "opensandbox"].includes(process.env.RUNTIME ?? "")
      ? process.env.RUNTIME
      : "local") as "local" | "docker" | "opensandbox",
    docker: {
      image: process.env.DOCKER_IMAGE ?? "tinyhands-sandbox:latest",
    },
    opensandbox: {
      serverUrl: process.env.OPENSANDBOX_SERVER_URL ?? "http://localhost:8080",
      apiKey: process.env.OPENSANDBOX_API_KEY || undefined,
      // run_code 依赖此专用镜像的内置 Jupyter kernel;普通 python 镜像无 /code 端点
      image:
        process.env.OPENSANDBOX_IMAGE ?? "opensandbox/code-interpreter:v1.1.0",
    },
  };
}

let cached: AppConfig | null = null;

/**
 * 读取全局配置(首次调用时从 env 读并冻结,之后返回同一份只读对象)。
 * 只读 = 冻结,杜绝运行期被意外改写。
 */
export function getConfig(): AppConfig {
  if (!cached) {
    const cfg = readConfig();
    cfg.llm = Object.freeze(cfg.llm);
    cfg.docker = Object.freeze(cfg.docker);
    cfg.opensandbox = Object.freeze(cfg.opensandbox);
    cached = Object.freeze(cfg);
  }
  return cached;
}
