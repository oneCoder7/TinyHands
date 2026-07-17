import type { Message, Delta } from "../llm/types.js";
import {
  EventStream,
  projectCompactedContext,
  type Event,
  type EventDraft,
  type EventHandler,
  type PublicEvent,
  type PublicEventHandler,
} from "./events.js";
import type { EventAppender } from "./conversation-store.js";
import type { TinyhandsLogger } from "../logging/logger.js";

/**
 * Conversation —— 一次会话的聚合根,会话的边界与身份锚点。
 *
 * 只持有 EventStream(唯一真相源)与会话身份，不持有进程内执行资源。
 * 读写分离:stream 私有,subscribe 是读的唯一出口,emit/emitDelta 是写(事实上只被
 * Agent 调)。不持有 Agent:agent.run(conversation),驱动器依赖数据、数据不依赖驱动器,
 * 换 agent 类型 conv 不动。
 *
 * 持久化:EventStream 接 ConversationStore 的追加端口落盘。恢复场景经 initialEvents 灌入历史事件,
 * Runtime 的惰性创建与释放属于 AgentSession，故「读回历史」不触发执行环境。
 */
export class Conversation {
  readonly id: string;
  private readonly stream: EventStream;

  constructor(
    id: string,
    opts: {
      store?: EventAppender;
      initialEvents?: Event[];
      logger?: TinyhandsLogger;
    } = {}
  ) {
    this.id = id;
    this.stream = new EventStream(opts.store, id, opts.initialEvents, opts.logger);
  }

  /**
   * 写侧:追加一个事件到真相源(id/timestamp 由 EventStream 注入)。
   * 异步:先落盘成功再广播,故调用方须 await(落盘失败会抛出)。
   */
  emit(draft: EventDraft): Promise<Event> {
    return this.stream.emit(draft);
  }

  /**
   * 广播一个瞬态 Delta(只推订阅者、不入真相源)。与 emit 的区别是持久化命运:
   * emit 沉淀事实,emitDelta 流过即蒸发。对外仍走 Conversation 单一入口。
   */
  emitDelta(delta: Delta): void {
    this.stream.emitDelta(delta);
  }

  /** 读侧:下游订阅事件流的唯一出口 */
  subscribe(handler: EventHandler): void {
    this.stream.subscribe(handler);
  }

  /** 移除订阅者(观察者断开时调用) */
  unsubscribe(handler: EventHandler): void {
    this.stream.unsubscribe(handler);
  }

  /** 对外订阅：内部 provider replay 已剥离，WS/SSE 只能使用此入口。 */
  subscribePublic(handler: PublicEventHandler): void {
    this.stream.subscribePublic(handler);
  }

  unsubscribePublic(handler: PublicEventHandler): void {
    this.stream.unsubscribePublic(handler);
  }

  /** 断线重连补发 —— 取 seq>afterSeq 的历史事件 */
  getEventsSince(afterSeq: number): Event[] {
    return this.stream.getEventsSince(afterSeq);
  }

  getPublicEventsSince(afterSeq: number): PublicEvent[] {
    return this.stream.getPublicEventsSince(afterSeq);
  }

  /** 投影出喂 LLM 的 Message[](下游消费格式,每次重算) */
  toMessages(): Message[] {
    return projectCompactedContext(this.stream.getEvents()).messages;
  }

  /** 全量事件副本(审计用) */
  getEvents(): Event[] {
    return this.stream.getEvents();
  }

  getPublicEvents(): PublicEvent[] {
    return this.stream.getPublicEvents();
  }
}
