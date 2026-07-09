import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { AgentSession, SessionFactory } from "./agent-session.js";
import type { EventStore } from "../conversation/event-store.js";
import { findUnmatchedToolCalls } from "../conversation/events.js";
import { logger } from "../core/logger.js";

const log = logger.child({ module: "conv-manager" });

export interface ConversationSummary {
  conversationId: string;
  createdAt: number;
  running: boolean;
  eventCount: number;
  /** 会话当前是否已加载进内存(活跃)。false=仅存磁盘、按需懒恢复。 */
  resident: boolean;
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
 *  - create:mkdir 专属 workspace + 经工厂装配会话(空事件流,不起 runtime)。id 可
 *    外部指定,不传则生成 UUID。
 *  - getOrResume:内存命中直接返回;未命中则从 EventStore 懒加载恢复(load 历史 →
 *    装配会话 → 孤儿 tool_call 补偿)。恢复纯读磁盘,绝不触发 runtime(D10)。
 *  - destroy:回调 onDestroy + Map 移除 + rm -rf workspace(含 events.jsonl)。
 *    协作式止血:abort 让 run 撞检查点终结,但不杀进行中的工具进程。
 *
 * 持久化语义:
 *  - destroy = 用户主动删:events + workspace 全删,不可 resume。
 *  - 崩溃/重启 = 没人删:events 在、workspace 目录在,getOrresume 按同 id 找回,
 *    新 runtime 实例接旧目录(D9)。
 */
export class ConversationManager {
  private readonly map = new Map<string, AgentSession>();
  private readonly workspaceRoot: string;
  private readonly createSession: SessionFactory;
  private readonly store: EventStore;
  /** 会话销毁时的回调(gateway 注册,用于关掉该会话的 WS)。manager 自己不碰 socket。 */
  private readonly destroyHandlers: Array<(id: string) => void> = [];
  /**
   * 懒加载加载锁:防止并发请求对同一未加载会话重复 load+装配。
   * 值是该会话正在进行的 load Promise,后续并发者 await 同一个。
   */
  private readonly loading = new Map<string, Promise<AgentSession | undefined>>();

  constructor(opts: {
    workspaceRoot: string;
    createSession: SessionFactory;
    eventStore: EventStore;
  }) {
    this.workspaceRoot = opts.workspaceRoot;
    this.createSession = opts.createSession;
    this.store = opts.eventStore;
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
    // 与磁盘已有会话撞 id 也算冲突(用户想新建,但该 id 历史会话还在)。
    const diskIds = await this.store.list();
    if (diskIds.includes(conversationId)) {
      throw new ConversationExistsError(conversationId);
    }

    // 每会话专属工作目录:workspaces/{convId}/(startup 时机 mkdir,同步可接受)。
    // 目录布局是 manager 的事,故 mkdir 在此、不在工厂里。events.jsonl + meta.json 也落此目录。
    const workspaceDir = join(this.workspaceRoot, conversationId);
    mkdirSync(workspaceDir, { recursive: true });

    const session = await this.createSession({ conversationId, workspaceDir, tools });

    // 持久化元信息(恢复时用它重建工具清单 + 显示原始创建时间)。
    // 落盘失败:会话已装配,但元信息没落 → 重启后恢复会用默认工具集 + createdAt=0。
    // 不阻断 create(元信息缺失只降级,不致功能不可用)。
    try {
      await this.store.saveMeta(conversationId, {
        createdAt: session.createdAt,
        tools,
      });
    } catch (err) {
      log.warn({ err, conversationId }, "saveMeta 失败,会话可用但恢复时元信息缺失");
    }

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

  /**
   * 取会话,内存未命中则从磁盘懒加载恢复。恢复 = load 历史 events → 装配会话 →
   * 孤儿 tool_call 补偿(给崩在「tool_use 已落、tool_result 未落」窗口的尾部补配对)。
   * 全程纯读磁盘 + 装配,绝不 runtime.create()(runtime 惰性,首次 driveRun 才起)。
   *
   * 并发安全:同一 id 的并发 getOrResume 复用同一个 load Promise,不会重复装配。
   *
   * @returns 命中/恢复成功返回 AgentSession;磁盘也没有则 undefined(会话不存在)。
   */
  async getOrResume(id: string): Promise<AgentSession | undefined> {
    const resident = this.map.get(id);
    if (resident) return resident;

    // 已有并发加载在进行:复用同一个 Promise,不重复 load。
    const inflight = this.loading.get(id);
    if (inflight) return inflight;

    const loadP = this.resumeFromDisk(id);
    this.loading.set(id, loadP);
    try {
      const session = await loadP;
      if (session) this.map.set(id, session);
      return session;
    } finally {
      this.loading.delete(id);
    }
  }

  /**
   * 从磁盘恢复一个会话。load → 装配(带 initialEvents)→ 孤儿补偿。
   * 不在 map 里登记(由 getOrResume 统一登记,避免此方法被并发直接调用时漏锁)。
   */
  private async resumeFromDisk(id: string): Promise<AgentSession | undefined> {
    const events = await this.store.load(id);
    if (events.length === 0) return undefined; // 磁盘无此会话(或坏尾后空)

    const meta = await this.store.loadMeta(id); // 可能 undefined(坏 JSON/缺失),退化用默认
    const workspaceDir = join(this.workspaceRoot, id);
    // 目录一般还在(崩溃不删目录);兜底重建以防被手动清掉。
    mkdirSync(workspaceDir, { recursive: true });

    // 装配:initialEvents 灌进 EventStream 续接历史;initialMeta 传 tools+createdAt。
    const session = await this.createSession({
      conversationId: id,
      workspaceDir,
      initialEvents: events,
      initialMeta: meta,
    });

    // 孤儿 tool_call 补偿:崩在「tool_use 已落盘、tool_result 未落盘」窗口,
    // 尾部残留无配对的 tool_use。按 toolCallId 各补一条 isError tool_result,
    // 否则重投影喂 LLM 必 400(Anthropic 硬约束)。与 agent 检查点③同一模式。
    const orphans = findUnmatchedToolCalls(events);
    if (orphans.length > 0) {
      log.warn(
        { conversationId: id, count: orphans.length },
        "恢复发现孤儿 tool_call,补偿 error tool_result"
      );
      for (const tc of orphans) {
        await session.conversation.emit({
          type: "tool_result",
          source: "environment",
          toolCallId: tc.id,
          content: "进程中断,该工具未完成执行",
          isError: true,
        });
      }
    }

    // 日志订阅者(与 create 同款,恢复路径也要挂)。
    session.conversation.subscribe((item) => {
      if ("delta" in item) return;
      log.debug({ conversationId: id, seq: item.seq, type: item.type }, "event");
    });

    log.info(
      { conversationId: id, eventsLoaded: events.length, orphans: orphans.length },
      "会话已从磁盘恢复"
    );
    return session;
  }

  /** 彻底销毁:回调 onDestroy(外部关连接) + kill runtime + Map 移除 + 删 workspace。不存在返回 false。 */
  async destroy(id: string): Promise<boolean> {
    const session = this.map.get(id);
    // 内存没有但磁盘有(未加载的历史会话被删):也要清磁盘。此时无 runtime 可 kill。
    const resident = !!session;

    // 先摘 Map:destroy 之后新连接/新请求一律按不存在处理
    if (session) this.map.delete(id);

    if (session) {
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
    }

    // 删数据:workspace 整目录(含 events.jsonl —— 与 workspace 同目录,一并清)。
    // 纵深防御(第二道)—— 即便 router 白名单被绕过,resolve 后校验它必须落在
    // workspaceRoot 之内,绝不删到根之外。
    const dir = join(this.workspaceRoot, id);
    const resolved = resolve(dir);
    if (!resolved.startsWith(resolve(this.workspaceRoot) + sep)) {
      log.error({ conversationId: id, dir: resolved }, "workspace 越界,拒绝删除");
    } else {
      rmSync(resolved, { recursive: true, force: true });
    }
    log.info({ conversationId: id, resident }, "会话已销毁");
    return resident || (await this.store.list()).includes(id);
  }

  /**
   * 会话概要列表。合并「内存活跃会话」+「磁盘未加载会话」。
   * 纯读,绝不触发 runtime(磁盘会话只 load 事件计数,不起执行环境)。
   * connections(在连 WS 数)不在此 —— manager 不认识连接,
   * 由 router 用 gateway 注入的 getConnectionCount 组装进响应。
   */
  async list(): Promise<ConversationSummary[]> {
    const summaries: ConversationSummary[] = [];

    // 内存活跃会话
    for (const [conversationId, s] of this.map) {
      summaries.push({
        conversationId,
        createdAt: s.createdAt,
        running: s.running,
        eventCount: s.conversation.getEvents().length,
        resident: true,
      });
    }

    // 磁盘未加载会话(内存未命中的)
    const residentIds = new Set(this.map.keys());
    const inflightIds = new Set(this.loading.keys());
    const diskIds = (await this.store.list()).filter(
      (id) => !residentIds.has(id) && !inflightIds.has(id)
    );
    for (const id of diskIds) {
      const events = await this.store.load(id);
      const meta = await this.store.loadMeta(id);
      summaries.push({
        conversationId: id,
        createdAt: meta?.createdAt ?? 0, // meta 缺失退化用 0
        running: false, // 不在内存必不在跑
        eventCount: events.length,
        resident: false,
      });
    }

    return summaries;
  }
}
