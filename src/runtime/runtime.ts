/**
 * Runtime —— 「执行环境」的 RPC 边界接口。
 *
 * 把「工具在哪执行」从「工具是什么」里解耦:工具只表达意图(跑命令/读写文件),
 * 在哪执行由具体实现决定。调用方 = server 侧的 tool.execute;执行方 = runtime 侧
 * (Local=server 进程内 / Docker=容器内 execd / OpenSandbox/E2B=云沙箱)。三种实现
 * 即三种 transport:进程内直接调用、HTTP 私有协议、SDK。接口签名即 RPC 契约,
 * 新增沙箱后端 = 实现本接口,不动 Agent loop、不动工具。
 *
 * 同时管 exec + 文件读写:容器内执行时命令产生的文件在容器内,读写若走宿主 fs 会
 * 文件系统分裂,故一次切对边界。Runtime ≠ Sandbox:本身不含隔离,LocalRuntime 就是
 * 本机裸跑;带隔离的实现(DockerRuntime / OpenSandboxRuntime)才引入沙箱。
 *
 * 边界语义(按机器分,非按目录名分):server 机器的 ~/workspace 放 events+meta
 * (控制面);runtime 机器的等价 ~/workspace 放执行产物(数据面)。Local 同机同目录
 * = 接受不隔离(选 Local 即表示无不可信代码或业务方自管隔离);Docker/OpenSandbox
 * 的产物在容器/云沙箱内,与 server 侧 events 天然物理分离。
 *
 * 生命周期:create 必须在 exec/readFile/writeFile 之前调用,kill 之后不得再调执行面
 * 方法。LocalRuntime 的 create/kill 为 no-op;DockerRuntime 的 create = 建+启容器+等
 * ready,kill = stop+remove。
 *
 * 实现:LocalRuntime / DockerRuntime / OpenSandboxRuntime。
 */
export interface Runtime {
  /** 生命周期:创建执行环境。LocalRuntime 为 no-op。 */
  create(): Promise<void>;
  /** 执行一条 shell 命令 */
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** 读文件(相对 runtime 的文件系统) */
  readFile(path: string): Promise<string>;
  /** 写文件(覆盖) */
  writeFile(path: string, content: string): Promise<void>;

  /**
   * 在 Jupyter kernel 中执行代码。与 exec 互补:exec 跑 bash 一次性命令,runCode 跑
   * Python/JS 等语言代码,有表达式返回值和图片(matplotlib)捕获能力。
   * Local 实现检测宿主 jupyter 可用性,不可用则返回友好错误(不抛异常、不阻塞创建)。
   */
  runCode(code: string, opts?: { language?: string }): Promise<RunCodeResult>;

  /**
   * 在浏览器环境中执行 Playwright 脚本(page 对象已就绪)。用于抓取、填表、截图、UI
   * 测试。各实现依赖预装 Playwright,不可用则返回友好错误。
   */
  runBrowser(script: string): Promise<BrowserResult>;

  /** 生命周期:销毁执行环境。LocalRuntime 为 no-op。 */
  kill(): Promise<void>;
}

/** exec 的结构化结果 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  /** 退出码；超时等异常情形下为非 0 */
  exitCode: number;
}

/** Code Interpreter 执行结果 */
export interface RunCodeResult {
  stdout: string;
  stderr: string;
  /** 最后一个表达式的返回值(如有,对应 Jupyter 的 execute_result) */
  result?: string;
  /** base64 编码的图片列表(matplotlib 等生成的内联图片) */
  images: string[];
  /** 执行错误信息(Jupyter 的 ename: evalue) */
  error?: string;
}

/** Browser / Playwright 执行结果 */
export interface BrowserResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** 截图(base64 PNG) */
  screenshots?: string[];
}
