import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  type AgentSession,
  ConversationWaitingForInteractionError,
} from "./agent-session.js";
import type { AgentSessionFactory } from "./agent-session-factory.js";
import {
  ConversationMetadataExistsError,
  type ConversationStore,
} from "../conversation/conversation-store.js";
import {
  isConversationMetadataCurrent,
  type ConversationConfig,
  type ConversationMetadata,
  type StoredConversationMetadata,
} from "../conversation/conversation-metadata.js";
import {
  findHumanInteractionRequest,
  findHumanInteractionResolution,
  findPendingHumanInteraction,
  projectToolPolicyMode,
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
  RespondToInteractionInput,
  RespondToInteractionResult,
  SetToolPolicyResult,
  ConversationToolPolicyInput,
  SendMessageResult,
  ToolPolicyMode,
} from "@tinyhands/protocol";
import { HumanInteractionCoordinator } from "./human-interaction.js";

export { ConversationWaitingForInteractionError } from "./agent-session.js";
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
  setToolPolicy(
    conversationId: string,
    policy: ConversationToolPolicyInput
  ): Promise<SetToolPolicyResult>;
  respondToInteraction(
    conversationId: string,
    interactionId: string,
    input: RespondToInteractionInput<"approval">
  ): Promise<RespondToInteractionResult>;
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
 * Service 负责应用用例与持久化生命周期，AgentSessionFactory 负责单会话装配；
 * transport 只能调用 DTO/结果/EventSubscription API，拿不到 AgentSession。
 *
 * 生命周期:
 *  - create:mkdir 专属 workspace + 经工厂装配会话(空事件流,不起 runtime)。id 可
 *    外部指定,不传则生成 UUID。
 *  - resolve:内存命中直接返回;未命中则从 ConversationStore 懒加载历史并装配会话，
 *    再调用 AgentSession.recover()。Service 不解释 Agent 内部恢复状态机。
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
  private readonly createSession: AgentSessionFactory;
  private readonly store: ConversationStore;
  private readonly conversationDefaults: ConversationConfig;
  private readonly defaultToolPolicyMode: ToolPolicyMode;
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
    createSession: AgentSessionFactory;
    conversationStore: ConversationStore;
    conversationDefaults: ConversationConfig;
    defaultToolPolicyMode?: ToolPolicyMode;
    logger?: TinyhandsLogger;
  }) {
    this.workspaceRoot = opts.workspaceRoot;
    this.createSession = opts.createSession;
    this.store = opts.conversationStore;
    this.conversationDefaults = cloneConversationConfig(
      opts.conversationDefaults
    );
    validateToolPolicyMode(opts.defaultToolPolicyMode);
    this.defaultToolPolicyMode = opts.defaultToolPolicyMode ?? "default";
    this.log = (opts.logger ?? noopLogger).child({
      module: "conversation-service",
    });
  }

  async create(input: CreateConversationInput = {}): Promise<ConversationInfo> {
    this.assertOpen();
    const conversationId = input.conversationId ?? randomUUID();
    validateConversationId(conversationId);
    validateTools(input.tools);
    validateToolPolicyMode(input.toolPolicy?.mode);

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

      const metadata = this.createMetadata(conversationId, input.tools);
      let session: AgentSession | undefined;
      try {
        await this.store.create(metadata);
        session = await this.createSession({
          metadata,
          workspaceDir,
        });
        await session.conversation.emit({
          type: "tool_policy_mode_changed",
          source: "environment",
          mode: input.toolPolicy?.mode ?? this.defaultToolPolicyMode,
        });
      } catch (err) {
        if (err instanceof ConversationMetadataExistsError) {
          // 排他 create 发现已有 record 时绝不能回滚目录，否则会删除既有会话。
          throw new ConversationExistsError(conversationId);
        }
        if (session) {
          try {
            await session.close();
          } catch (closeError) {
            this.log.error(
              { conversationId, err: closeError },
              "创建失败后的 AgentSession 关闭失败，保留 metadata 供恢复"
            );
            throw new AggregateError(
              [err, closeError],
              "Conversation 创建与回滚均失败"
            );
          }
        }
        await this.store.delete(conversationId);
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
        createdAt: session.conversation.createdAt,
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

  async setToolPolicy(
    conversationId: string,
    policy: ConversationToolPolicyInput
  ): Promise<SetToolPolicyResult> {
    this.assertOpen();
    validateConversationId(conversationId);
    validateToolPolicyMode(policy?.mode);
    return this.withOperation(conversationId, async () => {
      const session = await this.resolveSession(conversationId);
      if (!session) throw new ConversationNotFoundError(conversationId);
      const current = projectToolPolicyMode(session.conversation.getEvents());
      if (current === policy.mode) return { mode: current, changed: false };
      await session.conversation.emit({
        type: "tool_policy_mode_changed",
        source: "environment",
        mode: policy.mode,
      });
      return { mode: policy.mode, changed: true };
    });
  }

  async respondToInteraction(
    conversationId: string,
    interactionId: string,
    input: RespondToInteractionInput<"approval">
  ): Promise<RespondToInteractionResult> {
    this.assertOpen();
    validateConversationId(conversationId);
    if (!interactionId) {
      throw new InvalidConversationInputError("interactionId 不能为空");
    }
    return this.withOperation(conversationId, async () => {
      const session = await this.resolveSession(conversationId);
      if (!session) throw new ConversationNotFoundError(conversationId);
      const events = session.conversation.getEvents();
      const request = findHumanInteractionRequest(events, interactionId);
      const alreadyResolved = findHumanInteractionResolution(events, interactionId);
      const result = await new HumanInteractionCoordinator().respond(
        session.conversation,
        interactionId,
        input
      );
      if (request && !alreadyResolved) void session.resumeInteraction(request);
      return result;
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
   * AgentSession.recover()；普通历史不会启动 runtime。
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
    const { events } = persisted;
    const metadata = await this.resolveMetadata(persisted.metadata);

    const workspaceDir = join(this.workspaceRoot, id);
    // 目录一般还在(崩溃不删目录);兜底重建以防被手动清掉。
    mkdirSync(workspaceDir, { recursive: true });

    // 装配：metadata 已完整解析；initialEvents 灌进 EventStream 续接历史。
    const session = await this.createSession({
      metadata,
      workspaceDir,
      initialEvents: events,
    });

    // Agent 内部恢复 facade 负责 Compaction、ToolCall 与 continuation 规则；
    // Service 不解释 Agent Event 配对，Run Log 也不作为消息恢复来源。
    await session.recover();

    // 日志订阅者(与 create 同款,恢复路径也要挂)。
    session.conversation.subscribe((item) => {
      if ("delta" in item) return;
      this.log.debug({ conversationId: id, seq: item.seq, type: item.type }, "event");
    });

    this.log.info(
      { conversationId: id, eventsLoaded: events.length },
      "会话已从磁盘恢复"
    );
    return session;
  }

  private createMetadata(
    conversationId: string,
    tools: readonly string[] | undefined
  ): ConversationMetadata {
    return {
      schemaVersion: 2,
      conversationId,
      createdAt: Date.now(),
      config: {
        ...cloneConversationConfig(this.conversationDefaults),
        tools: [...(tools ?? this.conversationDefaults.tools)],
      },
    };
  }

  private async resolveMetadata(
    stored: StoredConversationMetadata
  ): Promise<ConversationMetadata> {
    if (isConversationMetadataCurrent(stored)) return stored;
    const metadata: ConversationMetadata = {
      schemaVersion: 2,
      conversationId: stored.conversationId,
      createdAt: stored.createdAt,
      config: {
        ...cloneConversationConfig(this.conversationDefaults),
        tools: [...(stored.tools ?? this.conversationDefaults.tools)],
      },
    };
    await this.store.replaceMetadata(metadata);
    return metadata;
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
    for (const [conversationId, session] of this.map) {
      conversations.push({
        conversationId,
        createdAt: session.conversation.createdAt,
        running: session.running,
      });
    }

    // 磁盘未加载会话(内存未命中的)
    const residentIds = new Set(this.map.keys());
    const inflightIds = new Set(this.loading);
    const diskMetadata = (await this.store.list()).filter(
      (metadata) =>
        !residentIds.has(metadata.conversationId) &&
        !inflightIds.has(metadata.conversationId)
    );
    for (const metadata of diskMetadata) {
      conversations.push({
        conversationId: metadata.conversationId,
        createdAt: metadata.createdAt,
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

function validateToolPolicyMode(mode: ToolPolicyMode | undefined): void {
  if (mode === undefined) return;
  if (
    mode !== "request_approval" &&
    mode !== "default" &&
    mode !== "full_access"
  ) {
    throw new InvalidConversationInputError("toolPolicy.mode 不合法");
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

function cloneConversationConfig(
  config: ConversationConfig
): ConversationConfig {
  return {
    tools: [...config.tools],
    maxSteps: config.maxSteps,
    maxModelAttemptsPerStep: config.maxModelAttemptsPerStep,
    autoCompact: { ...config.autoCompact },
  };
}
