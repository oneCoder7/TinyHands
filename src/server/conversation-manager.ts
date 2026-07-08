import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AgentSession, SessionFactory } from "./agent-session.js";
import { logger } from "../core/logger.js";

const log = logger.child({ module: "conv-manager" });

export interface ConversationSummary {
  conversationId: string;
  createdAt: number;
  running: boolean;
  eventCount: number;
}

/** create 时 id 已存在(REST 层转 409) */
export class ConversationExistsError extends Error {
  constructor(id: string) {
    super(`conversation 已存在：${id}`);
  }
}

/**
 * ConversationManager —— server 层的多路复用注册表。一个进程持 N 个 AgentSession,
 * 按 conversationId 索引。内核对它一无所知(依赖方向:server → 内核)。
 *
 * 职责收窄:只管建/取/关会话,自己从不 new 组件(装配交给注入的 SessionFactory),
 * 也不认识传输层(WebSocket 由 gateway 自持,manager 只在销毁时经 onDestroy 通知)。
 *
 * 生命周期:
 *  - create:mkdir 专属 workspace + 经工厂装配会话。id 可外部指定(未来 resume 按同
 *    一 id 找回),不传则生成 UUID。
 *  - destroy:回调 onDestroy(外部断连) + Map 移除 + rm -rf workspace。进行中的 run
 *    协作式止血:abort 让它尽快撞检查点终结,但不杀进行中的工具进程。
 */
export class ConversationManager {
  private readonly map = new Map<string, AgentSession>();
  private readonly workspaceRoot: string;
  private readonly createSession: SessionFactory;
  /** 会话销毁时的回调(gateway 注册,用于关掉该会话的 WS)。manager 自己不碰 socket。 */
  private readonly destroyHandlers: Array<(id: string) => void> = [];

  constructor(opts: { workspaceRoot: string; createSession: SessionFactory }) {
    this.workspaceRoot = opts.workspaceRoot;
    this.createSession = opts.createSession;
  }

  /** 注册销毁回调:会话被 destroy 时按 id 回调,外部(gateway)据此关连接/清理。 */
  onDestroy(cb: (id: string) => void): void {
    this.destroyHandlers.push(cb);
  }

  async create(id?: string, tools?: string[]): Promise<AgentSession> {
    const conversationId = id ?? randomUUID();
    if (this.map.has(conversationId)) {
      throw new ConversationExistsError(conversationId);
    }

    // 每会话专属工作目录:workspaces/{convId}/(startup 时机 mkdir,同步可接受)。
    // 目录布局是 manager 的事,故 mkdir 在此、不在工厂里。
    const workspaceDir = join(this.workspaceRoot, conversationId);
    mkdirSync(workspaceDir, { recursive: true });

    const session = await this.createSession({ conversationId, workspaceDir, tools });

    // 日志订阅者:该会话每条事件记进服务端日志。它与 WS 连接平级,都是
    // EventStream 的订阅者(多消费者),不依赖有没有客户端连着。
    session.conversation.subscribe((item) => {
      if ("delta" in item) return; // Delta 太碎,不逐条打(避免刷屏)
      log.debug({ conversationId, seq: item.seq, type: item.type }, "event");
    });

    this.map.set(conversationId, session);
    log.info({ conversationId, workspaceDir }, "会话已创建");
    return session;
  }

  get(id: string): AgentSession | undefined {
    return this.map.get(id);
  }

  /** 彻底销毁:回调 onDestroy(外部关连接) + kill runtime + Map 移除 + 删 workspace。不存在返回 false。 */
  async destroy(id: string): Promise<boolean> {
    const session = this.map.get(id);
    if (!session) return false;

    // 先摘 Map:destroy 之后新连接/新请求一律按不存在处理
    this.map.delete(id);

    // 止血:中止进行中的 run(不 emit interrupted —— 会话已销毁,无需留痕),
    // 让它尽快撞检查点终结。进行中的工具不杀,残留竞态无害。
    session.runAbort?.abort();

    // 通知外部观察者(gateway 关该会话全部 WS/SSE)。回调异常不得中断销毁流程,逐个隔离。
    for (const cb of this.destroyHandlers) {
      try {
        cb(id);
      } catch (err) {
        log.warn({ err, conversationId: id }, "onDestroy 回调异常,已隔离");
      }
    }

    // 释放执行环境(DockerRuntime = stop+remove 容器;LocalRuntime = no-op)。
    // 必须在 rm workspace 之前:bind mount 源被删但容器还挂着 = 不干净。
    try {
      await session.conversation.runtime.kill();
    } catch (err) {
      log.warn({ err, conversationId: id }, "runtime.kill 异常,继续销毁流程");
    }

    // 删数据:workspace 整目录。纵深防御(第二道)—— 即便 router 白名单被绕过,
    // resolve 后校验它必须落在 workspaceRoot 之内,绝不删到根之外。
    const resolved = resolve(session.workspaceDir);
    if (!resolved.startsWith(resolve(this.workspaceRoot) + sep)) {
      log.error({ conversationId: id, dir: resolved }, "workspace 越界,拒绝删除");
    } else {
      rmSync(resolved, { recursive: true, force: true });
    }
    log.info({ conversationId: id }, "会话已销毁");
    return true;
  }

  /**
   * 会话概要列表。connections(在连 WS 数)不在此 —— manager 不认识连接,
   * 由 router 用 gateway 注入的 getConnectionCount 组装进响应。
   */
  list(): ConversationSummary[] {
    return [...this.map.entries()].map(([conversationId, s]) => ({
      conversationId,
      createdAt: s.createdAt,
      running: s.running,
      eventCount: s.conversation.getEvents().length,
    }));
  }
}
