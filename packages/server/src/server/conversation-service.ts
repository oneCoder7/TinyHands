import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  type AgentSession,
  type SessionFactory,
} from "./agent-session.js";
import {
  ConversationRecordExistsError,
  type ConversationStore,
} from "../conversation/conversation-store.js";
import {
  findUnmatchedToolCalls,
  type Event,
  type PublicEventHandler,
  type PublicStreamItem,
} from "../conversation/events.js";
import type { Conversation } from "../conversation/conversation.js";
import type {
  CreateConversationInput,
  ConversationInfo,
  DeleteConversationResult,
  EventSubscriptionCloseReason,
  InterruptResult,
  SendMessageResult,
} from "@tinyhands/protocol";
import { listOptionalToolNames } from "../tools/catalog.js";
import {
  noopLogger,
  type TinyhandsLogger,
} from "../logging/logger.js";

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BUFFERED_STREAM_ITEMS = 1024;

export interface OpenEventStreamOptions {
  afterSeq?: number;
  signal?: AbortSignal;
}

export interface EventSubscription extends AsyncIterable<PublicStreamItem> {
  readonly closeReason: EventSubscriptionCloseReason | undefined;
  close(): Promise<void>;
}

/** create 时 id 已存在(REST 层转 409) */
export class ConversationExistsError extends Error {
  constructor(id: string) {
    super(`conversation 已存在：${id}`);
  }
}

export class ConversationNotFoundError extends Error {
  constructor(id: string) {
    super(`conversation 不存在：${id}`);
  }
}

export class InvalidConversationInputError extends Error {}

export class EventStreamOverflowError extends Error {
  constructor(id: string) {
    super(`conversation 事件订阅积压过多：${id}`);
  }
}

export class ConversationServiceClosingError extends Error {
  constructor() {
    super("ConversationService 正在关闭");
  }
}

export class ConversationServiceClosedError extends Error {
  constructor() {
    super("ConversationService 已关闭");
  }
}

/** Host 对外暴露的多会话应用端口，不包含具体实现的装配构造器。 */
export interface ConversationService {
  create(input?: CreateConversationInput): Promise<ConversationInfo>;
  send(conversationId: string, text: string): Promise<SendMessageResult>;
  interrupt(conversationId: string): Promise<InterruptResult>;
  events(
    conversationId: string,
    options?: OpenEventStreamOptions
  ): Promise<EventSubscription>;
  delete(id: string): Promise<DeleteConversationResult>;
  list(): Promise<ConversationInfo[]>;
  close(): Promise<void>;
}

/**
 * ConversationService —— framework-agnostic 的多会话应用服务。
 *
 * Service 负责应用用例与持久化生命周期，SessionFactory 负责单会话装配；
 * transport 只能调用 DTO/结果/EventSubscription API，拿不到 AgentSession。
 *
 * 生命周期:
 *  - create:mkdir 专属 workspace + 经工厂装配会话(空事件流,不起 runtime)。id 可
 *    外部指定,不传则生成 UUID。
 *  - resolve:内存命中直接返回;未命中则从 ConversationStore 懒加载恢复(load 历史 →
 *    装配会话 → 孤儿 tool_call 补偿)。恢复纯读磁盘,绝不触发 runtime(D10)。
 *  - delete:Map 移除 + 关闭公开订阅 + rm -rf workspace(含 events.jsonl)。
 *    协作式止血:abort 让 run 撞检查点终结,但不杀进行中的工具进程。
 *
 * 持久化语义:
 *  - destroy = 用户主动删:events + workspace 全删,不可 resume。
 *  - 崩溃/重启 = 没人删:events 在、workspace 目录在,getOrresume 按同 id 找回,
 *    新 runtime 实例接旧目录(D9)。
 */
export class DefaultConversationService implements ConversationService {
  private readonly map = new Map<string, AgentSession>();
  private readonly workspaceRoot: string;
  private readonly createSession: SessionFactory;
  private readonly store: ConversationStore;
  private readonly log: TinyhandsLogger;
  private readonly subscriptions = new Map<string, Set<EventSubscriptionImpl>>();
  /** 同一 conversationId 的 create/resume/destroy 必须串行，避免双实例与删除后复活。 */
  private readonly operations = new Map<string, Promise<void>>();
  /** list 用于排除正在恢复、尚未进入 map 的会话。 */
  private readonly loading = new Set<string>();
  private state: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | undefined;

  constructor(opts: {
    workspaceRoot: string;
    createSession: SessionFactory;
    conversationStore: ConversationStore;
    logger?: TinyhandsLogger;
  }) {
    this.workspaceRoot = opts.workspaceRoot;
    this.createSession = opts.createSession;
    this.store = opts.conversationStore;
    this.log = (opts.logger ?? noopLogger).child({
      module: "conversation-service",
    });
  }

  async create(input: CreateConversationInput = {}): Promise<ConversationInfo> {
    this.assertOpen();
    const conversationId = input.conversationId ?? randomUUID();
    validateConversationId(conversationId);
    validateTools(input.tools);

    return this.withOperation(conversationId, async () => {
      if (this.map.has(conversationId)) {
        throw new ConversationExistsError(conversationId);
      }
      // 与磁盘已有会话撞 id 也算冲突(用户想新建,但该 id 历史会话还在)。
      if (await this.store.exists(conversationId)) {
        throw new ConversationExistsError(conversationId);
      }

      // 每会话专属工作目录:workspaces/{convId}/(startup 时机 mkdir,同步可接受)。
      // 目录布局是 manager 的事,故 mkdir 在此、不在工厂里。events.jsonl + meta.json 也落此目录。
      const workspaceDir = join(this.workspaceRoot, conversationId);
      mkdirSync(workspaceDir, { recursive: true });

      let session: AgentSession;
      try {
        session = await this.createSession({
          conversationId,
          workspaceDir,
          tools: input.tools,
        });

        // metadata 决定 Conversation 是否存在，也决定恢复时的工具配置。写失败不能
        // 返回成功，否则重启后会话消失或静默换成默认工具集。
        await this.store.create({
          schemaVersion: 1,
          conversationId,
          createdAt: session.conversationCreatedAt,
          tools: input.tools,
        });
      } catch (err) {
        if (err instanceof ConversationRecordExistsError) {
          // 排他 create 发现已有 record 时绝不能回滚目录，否则会删除既有会话。
          throw new ConversationExistsError(conversationId);
        }
        // runtime 尚未惰性启动；清掉本次 create 新建的半成品目录，允许安全重试。
        rmSync(workspaceDir, { recursive: true, force: true });
        throw err;
      }

      // 日志订阅者:该会话每条事件记进服务端日志。它与 WS 连接平级,都是
      // EventStream 的订阅者(多消费者),不依赖有没有客户端连着。
      session.conversation.subscribe((item) => {
        if ("delta" in item) return; // Delta 太碎,不逐条打(避免刷屏)
        this.log.debug({ conversationId, seq: item.seq, type: item.type }, "event");
      });

      this.map.set(conversationId, session);
      this.log.info({ conversationId, workspaceDir }, "会话已创建");
      return {
        conversationId,
        createdAt: session.conversationCreatedAt,
        running: false,
      };
    });
  }

  async send(conversationId: string, text: string): Promise<SendMessageResult> {
    this.assertOpen();
    validateConversationId(conversationId);
    if (typeof text !== "string" || text.length === 0) {
      throw new InvalidConversationInputError("消息 text 必须是非空字符串");
    }

    return this.withOperation(conversationId, async () => {
      const session = await this.resolveSession(conversationId);
      if (!session) throw new ConversationNotFoundError(conversationId);
      const submitted = await session.submit(text);
      return {
        accepted: true,
        running: session.running,
        triggerId: submitted.triggerId,
      };
    });
  }

  async interrupt(conversationId: string): Promise<InterruptResult> {
    this.assertOpen();
    validateConversationId(conversationId);
    return this.withOperation(conversationId, async () => {
      const session = await this.resolveSession(conversationId);
      if (!session) throw new ConversationNotFoundError(conversationId);
      return { interrupted: await session.interrupt() };
    });
  }

  async events(
    conversationId: string,
    options: OpenEventStreamOptions = {}
  ): Promise<EventSubscription> {
    this.assertOpen();
    validateConversationId(conversationId);
    const afterSeq = options.afterSeq ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new InvalidConversationInputError("afterSeq 必须是非负整数");
    }

    return this.withOperation(conversationId, async () => {
      const session = await this.resolveSession(conversationId);
      if (!session) throw new ConversationNotFoundError(conversationId);

      let set = this.subscriptions.get(conversationId);
      if (!set) {
        set = new Set();
        this.subscriptions.set(conversationId, set);
      }
      const subscription = new EventSubscriptionImpl(
        conversationId,
        session.conversation,
        afterSeq,
        () => {
          set?.delete(subscription);
          if (set?.size === 0 && this.subscriptions.get(conversationId) === set) {
            this.subscriptions.delete(conversationId);
          }
        }
      );
      set.add(subscription);
      subscription.bindSignal(options.signal);
      return subscription;
    });
  }

  /**
   * 取会话,内存未命中则从磁盘懒加载恢复。恢复 = load 历史 events → 装配会话 →
   * 孤儿 tool_call 补偿(给崩在「tool_use 已落、tool_result 未落」窗口的尾部补配对)。
   * 全程纯读磁盘 + 装配,绝不 runtime.create()(runtime 惰性,首次 driveRun 才起)。
   *
   * 并发安全:同一 id 的并发 resolve 经 per-ID coordinator 串行，不会重复装配。
   *
   * @returns 命中/恢复成功返回 AgentSession;磁盘也没有则 undefined(会话不存在)。
   */
  private async resolveSession(id: string): Promise<AgentSession | undefined> {
    const resident = this.map.get(id);
    if (resident) return resident;

    this.loading.add(id);
    try {
      const session = await this.resumeFromDisk(id);
      if (session) this.map.set(id, session);
      return session;
    } finally {
      this.loading.delete(id);
    }
  }

  /**
   * 从磁盘恢复一个会话。load → 装配(带 initialEvents)→ 孤儿补偿。
   * 不在 map 里登记(由 resolveSession 统一登记，避免绕过 per-ID coordinator)。
   */
  private async resumeFromDisk(id: string): Promise<AgentSession | undefined> {
    const persisted = await this.store.load(id);
    if (!persisted) return undefined;
    const { record, events } = persisted;

    const workspaceDir = join(this.workspaceRoot, id);
    // 目录一般还在(崩溃不删目录);兜底重建以防被手动清掉。
    mkdirSync(workspaceDir, { recursive: true });

    // 装配:initialEvents 灌进 EventStream 续接历史;initialRecord 传 tools+createdAt。
    const session = await this.createSession({
      conversationId: id,
      workspaceDir,
      initialEvents: events,
      initialRecord: record,
    });

    // 压缩恢复补偿必须先于接受新 run：checkpoint 已提交则补 completed；否则补
    // process_restarted cancelled。两种修复都只追加事件，不重放摘要请求。
    await recoverOpenCompactions(session);

    // 孤儿 tool_call 补偿:崩在「tool_use 已落盘、tool_result 未落盘」窗口,
    // 尾部残留无配对的 tool_use。按 toolCallId 各补一条 isError tool_result,
    // 否则重投影喂 LLM 必 400(Anthropic 硬约束)。与 agent 检查点③同一模式。
    const orphans = findUnmatchedToolCalls(events);
    if (orphans.length > 0) {
      this.log.warn(
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
      this.log.debug({ conversationId: id, seq: item.seq, type: item.type }, "event");
    });

    this.log.info(
      { conversationId: id, eventsLoaded: events.length, orphans: orphans.length },
      "会话已从磁盘恢复"
    );
    return session;
  }

  /** 永久删除：关闭观察窗口、停止 resident runtime，再删除持久数据。 */
  async delete(id: string): Promise<DeleteConversationResult> {
    this.assertOpen();
    validateConversationId(id);
    return this.withOperation(id, async () => {
      const session = this.map.get(id);
      // 删除前先记住磁盘存在性；删除后再 list 必然得出 false，会把成功误报为 404。
      const persisted = await this.store.exists(id);
      const resident = !!session;
      if (!resident && !persisted) throw new ConversationNotFoundError(id);

      // 先摘 Map:destroy 之后新连接/新请求一律按不存在处理
      if (session) this.map.delete(id);

      if (session) {
        // 必须等 driver 静止后再删数据，否则迟到的 error event 会重建刚删除的目录。
        try {
          await session.close();
        } catch (err) {
          // 无法确认 Session 已静止时不能报告删除成功，也不能删除持久数据。
          this.map.set(id, session);
          this.log.error(
            { err, conversationId: id },
            "AgentSession 关闭失败，保留数据供重试"
          );
          throw err;
        }
      }

      // 删数据:workspace 整目录(含 events.jsonl —— 与 workspace 同目录,一并清)。
      // 纵深防御(第二道)—— 即便 router 白名单被绕过,resolve 后校验它必须落在
      // workspaceRoot 之内,绝不删到根之外。
      const dir = join(this.workspaceRoot, id);
      const resolved = resolve(dir);
      if (!resolved.startsWith(resolve(this.workspaceRoot) + sep)) {
        this.log.error(
          { conversationId: id, dir: resolved },
          "workspace 越界,拒绝删除"
        );
        throw new InvalidConversationInputError("conversation workspace 越界");
      }

      const subscriptions = this.subscriptions.get(id);
      if (subscriptions) {
        await Promise.all(
          [...subscriptions].map((subscription) =>
            subscription.closeWithReason("conversation_deleted")
          )
        );
      }

      await this.store.delete(id);
      this.log.info({ conversationId: id, resident }, "会话已销毁");
      return { deleted: true };
    });
  }

  /**
   * 稳定会话列表。合并「内存活跃会话」+「磁盘未加载会话」。
   * 纯读,绝不触发 runtime，也不暴露 resident/eventCount 等实现统计。
   */
  async list(): Promise<ConversationInfo[]> {
    this.assertOpen();
    const conversations: ConversationInfo[] = [];

    // 内存活跃会话
    for (const [conversationId, s] of this.map) {
      conversations.push({
        conversationId,
        createdAt: s.conversationCreatedAt,
        running: s.running,
      });
    }

    // 磁盘未加载会话(内存未命中的)
    const residentIds = new Set(this.map.keys());
    const inflightIds = new Set(this.loading);
    const diskRecords = (await this.store.list()).filter(
      (record) =>
        !residentIds.has(record.conversationId) &&
        !inflightIds.has(record.conversationId)
    );
    for (const record of diskRecords) {
      conversations.push({
        conversationId: record.conversationId,
        createdAt: record.createdAt,
        running: false, // 不在内存必不在跑
      });
    }

    return conversations;
  }

  /**
   * 停止当前 Service 的运行资源，但保留所有持久 Conversation。
   *
   * 进入 closing 后不再接收新操作；先等待已经进入 per-ID coordinator 的操作
   * 完成，再关闭事件订阅和 resident Session。失败时保持 closing，允许调用方重试
   * 清理，但不会重新开放业务入口。
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === "closed") return Promise.resolve();
    this.state = "closing";

    const closing = (async () => {
      // state 已切到 closing，不会再有新 operation 入队；该快照包含此前所有操作。
      await Promise.all([...this.operations.values()]);

      const subscriptions = [...this.subscriptions.values()].flatMap((set) => [
        ...set,
      ]);
      await Promise.all(
        subscriptions.map((subscription) =>
          subscription.closeWithReason("host_closing")
        )
      );

      // 等齐全部结果再决定 close 成败，避免 Promise.all 提前 reject 后仍有清理悬空。
      const results = await Promise.allSettled(
        [...this.map.values()].map((session) => session.close())
      );
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "ConversationService 关闭失败");
      }

      this.map.clear();
      this.state = "closed";
      this.log.info("ConversationService 已关闭");
    })();

    this.closePromise = closing;
    void closing.then(undefined, () => {
      // 保持 closing，禁止新工作；仅允许再次调用 close 重试失败的资源清理。
      if (this.closePromise === closing) this.closePromise = undefined;
    });
    return closing;
  }

  /**
   * 同一 id 的生命周期操作串行化。锁只在当前进程/Host 内生效；v1 明确不支持
   * 多进程共享 workspaceRoot，不用本地锁伪装成分布式 ownership。
   */
  private async withOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.operations.set(id, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operations.get(id) === tail) this.operations.delete(id);
    }
  }

  private assertOpen(): void {
    if (this.state === "closing") throw new ConversationServiceClosingError();
    if (this.state === "closed") throw new ConversationServiceClosedError();
  }
}

function validateConversationId(id: string): void {
  if (!CONVERSATION_ID_RE.test(id)) {
    throw new InvalidConversationInputError(
      "conversationId 仅允许 [A-Za-z0-9_-]，长度 1-64"
    );
  }
}

function validateTools(tools: string[] | undefined): void {
  if (tools === undefined) return;
  if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string")) {
    throw new InvalidConversationInputError("tools 必须是字符串数组");
  }
  const known = listOptionalToolNames();
  const unknown = tools.filter((tool) => !known.includes(tool));
  if (unknown.length > 0) {
    throw new InvalidConversationInputError(
      `未知的工具:${unknown.join(", ")}。可用工具:${known.join(", ")}`
    );
  }
}

/**
 * Public event 的单消费者异步队列。构造时在同一同步调用栈内取得 backlog 并注册
 * live handler，因此 backlog 之后到达的事件只会排在其后，不留 transport 级竞态窗。
 */
class EventSubscriptionImpl
  implements EventSubscription, AsyncIterator<PublicStreamItem>
{
  private readonly backlog: PublicStreamItem[];
  private backlogIndex = 0;
  private readonly liveQueue: PublicStreamItem[] = [];
  private readonly handler: PublicEventHandler;
  private pending:
    | {
        resolve: (result: IteratorResult<PublicStreamItem>) => void;
        reject: (reason: unknown) => void;
      }
    | undefined;
  private closed = false;
  private failure: Error | undefined;
  private reason: EventSubscriptionCloseReason | undefined;
  private signal: AbortSignal | undefined;
  private abortHandler: (() => void) | undefined;

  constructor(
    private readonly conversationId: string,
    private readonly conversation: Conversation,
    afterSeq: number,
    private readonly onClose: () => void
  ) {
    this.backlog =
      afterSeq > 0
        ? conversation.getPublicEventsSince(afterSeq)
        : conversation.getPublicEvents();
    this.handler = (item) => this.enqueue(item);
    this.conversation.subscribePublic(this.handler);
  }

  [Symbol.asyncIterator](): AsyncIterator<PublicStreamItem> {
    return this;
  }

  next(): Promise<IteratorResult<PublicStreamItem>> {
    const backlogItem = this.backlog[this.backlogIndex];
    if (backlogItem !== undefined) {
      this.backlogIndex += 1;
      return Promise.resolve({ value: backlogItem, done: false });
    }

    const liveItem = this.liveQueue.shift();
    if (liveItem !== undefined) {
      return Promise.resolve({ value: liveItem, done: false });
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    if (this.pending) {
      return Promise.reject(new Error("EventSubscription 只允许一个消费者"));
    }

    return new Promise<IteratorResult<PublicStreamItem>>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  async return(): Promise<IteratorResult<PublicStreamItem>> {
    await this.close();
    return { value: undefined, done: true };
  }

  async close(): Promise<void> {
    return this.closeWithReason("observer_closed");
  }

  get closeReason(): EventSubscriptionCloseReason | undefined {
    return this.reason;
  }

  bindSignal(signal: AbortSignal | undefined): void {
    if (!signal || this.closed) return;
    this.signal = signal;
    this.abortHandler = () => void this.close();
    if (signal.aborted) {
      void this.close();
      return;
    }
    signal.addEventListener("abort", this.abortHandler, { once: true });
  }

  async closeWithReason(reason: EventSubscriptionCloseReason): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.reason = reason;
    this.detachSignal();
    this.conversation.unsubscribePublic(this.handler);
    this.onClose();
    this.pending?.resolve({ value: undefined, done: true });
    this.pending = undefined;
  }

  private enqueue(item: PublicStreamItem): void {
    if (this.closed) return;
    if (this.pending) {
      const { resolve } = this.pending;
      this.pending = undefined;
      resolve({ value: item, done: false });
      return;
    }
    if (this.liveQueue.length >= MAX_BUFFERED_STREAM_ITEMS) {
      this.fail(new EventStreamOverflowError(this.conversationId));
      return;
    }
    this.liveQueue.push(item);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.reason = "event_stream_overflow";
    this.detachSignal();
    this.conversation.unsubscribePublic(this.handler);
    this.onClose();
    this.pending?.reject(error);
    this.pending = undefined;
  }

  private detachSignal(): void {
    if (this.signal && this.abortHandler) {
      this.signal.removeEventListener("abort", this.abortHandler);
    }
    this.signal = undefined;
    this.abortHandler = undefined;
  }
}

async function recoverOpenCompactions(session: AgentSession): Promise<void> {
  const states = new Map<
    string,
    {
      started: boolean;
      terminal: boolean;
      checkpoint?: Extract<Event, { type: "compacted" }>;
    }
  >();
  for (const event of session.conversation.getEvents()) {
    if (
      event.type !== "compaction_started" &&
      event.type !== "compaction_completed" &&
      event.type !== "compaction_cancelled" &&
      event.type !== "compaction_failed" &&
      event.type !== "compacted"
    ) {
      continue;
    }
    const state = states.get(event.compactionId) ?? {
      started: false,
      terminal: false,
    };
    if (event.type === "compaction_started") state.started = true;
    if (event.type === "compacted") state.checkpoint = event;
    if (
      event.type === "compaction_completed" ||
      event.type === "compaction_cancelled" ||
      event.type === "compaction_failed"
    ) {
      state.terminal = true;
    }
    states.set(event.compactionId, state);
  }

  for (const [compactionId, state] of states) {
    if (!state.started || state.terminal) continue;
    if (state.checkpoint) {
      await session.conversation.emit({
        type: "compaction_completed",
        source: "agent",
        compactionId,
        throughSeq: state.checkpoint.throughSeq,
        estimatedBeforeTokens: state.checkpoint.estimatedBeforeTokens,
        estimatedAfterTokens: state.checkpoint.estimatedAfterTokens,
      });
    } else {
      await session.conversation.emit({
        type: "compaction_cancelled",
        source: "agent",
        compactionId,
        reason: "process_restarted",
      });
    }
  }
}
