/**
 * 事件系统 —— 会话的真相源。
 * 事件流是唯一真相源;Message[] 是投影出来喂 LLM 的下游格式。
 * EventStream 走观察者模式:生产者只 emit,不关心谁订阅(前端/日志/DB)。
 */

import type { ToolCall, Message, ThinkingBlock, Delta } from "../llm/types.js";
export type { Delta } from "../llm/types.js";
import { logger } from "../core/logger.js";

const log = logger.child({ module: "event-stream" });

/** 事件来源:Action(agent)/Observation(environment)/user 三分。 */
export type EventSource = "user" | "agent" | "environment";

interface BaseEvent {
  id: string;
  /** 单调递增序号(EventStream 注入)。断线重连按它过滤,补 seq>lastSeq 的事件。 */
  seq: number;
  timestamp: number;
  source: EventSource;
}

/**
 * 事件类型(判别联合)。
 *
 * thinking_finished 是 extended thinking 的定稿(带签名),必须入库:多轮带工具
 * 调用时上一轮 thinking 要原样带签名回传,否则 Anthropic API 400。流式过程态
 * (开始/增量/结束)是 Delta、不入库。
 */
export type Event =
  | (BaseEvent & { type: "user_message"; text: string })
  | (BaseEvent & { type: "agent_message"; text: string; toolCalls: ToolCall[] })
  | (BaseEvent & {
      type: "tool_result";
      toolCallId: string;
      content: string;
      isError: boolean;
    })
  | (BaseEvent & { type: "thinking_finished"; blocks: ThinkingBlock[] })
  | (BaseEvent & { type: "error"; message: string })
  | (BaseEvent & { type: "finished"; result: string })
  /** 用户打断了进行中的 run。source 固定 "user"——打断是用户动作,不是错误。 */
  | (BaseEvent & { type: "interrupted" });

/**
 * StreamItem —— 订阅者在同一条时间线上收到的东西:Event 或 Delta。
 * 二者走同一 handler 列表同步派发,用带 tag 的联合区分:Event 有 type,
 * Delta 包成 { delta }。Delta 定义在中性层 llm/types.ts,此处 re-export。
 */
export type StreamItem = Event | { delta: Delta };

/** 判别助手:StreamItem 是不是 Delta 包装。 */
export function isDelta(item: StreamItem): item is { delta: Delta } {
  return "delta" in item;
}

/**
 * 事件草稿:不含 id/seq/timestamp,这三个字段由 EventStream 统一注入。
 * 用分配式 Omit 保住判别联合的 type 收窄(裸 Omit 会把联合压平)。
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;
export type EventDraft = DistributiveOmit<Event, "id" | "seq" | "timestamp">;

/** 订阅者回调:收时间线上流过的东西(Event 或 Delta)。 */
export type EventHandler = (item: StreamItem) => void;

/**
 * EventStream —— 观察者模式的广播机。每个 Conversation 一条,同生命周期(绝非单例)。
 *  - emit(Event)      : push 进 events[](持久) + 广播,沉淀的「事实」
 *  - emitDelta(Delta) : 只广播不入库,流过的「瞬态信号」
 * 二者走同一 handlers 列表同步派发,保证 delta 与 event 严格同一时间线。
 */
export class EventStream {
  private events: Event[] = [];
  private handlers: EventHandler[] = [];
  private seq = 0;

  /** append 到真相源 + 同步通知所有订阅者。id/seq/timestamp 在此注入。 */
  emit(draft: EventDraft): Event {
    const seq = ++this.seq;
    const e = {
      ...draft,
      id: `evt-${seq}`,
      seq,
      timestamp: Date.now(),
    } as Event;
    this.events.push(e);
    // 快照副本:防订阅者在派发中 unsubscribe 造成 splice 冲突而跳过后续。
    // try/catch:订阅者故障不沿同步链炸掉 agent.run。不引 await 以保同步派发不变量。
    for (const h of [...this.handlers]) {
      try {
        h(e);
      } catch (err) {
        log.warn({ err, seq: e.seq, type: e.type }, "订阅者 handler 异常,已隔离");
      }
    }
    return e;
  }

  /**
   * 只广播、不入库的瞬态派发口。不 push events[]、不注入身份字段、不返回。
   * 与 emit 共用 handlers 同步派发。【不变量】此处及 emit 都不得引入 await,
   * 否则同步链断、delta/event 交错就可能发生。
   */
  emitDelta(delta: Delta): void {
    for (const h of [...this.handlers]) {
      try {
        h({ delta });
      } catch (err) {
        log.warn({ err }, "订阅者 handler 异常(delta),已隔离");
      }
    }
  }

  subscribe(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  /**
   * 移除订阅者。观察者(如 WS 连接)断开时必须调用,否则死连接的 handler
   * 残留:既内存泄漏、又会往已关闭的 socket 推事件。
   */
  unsubscribe(handler: EventHandler): void {
    const i = this.handlers.indexOf(handler);
    if (i !== -1) this.handlers.splice(i, 1);
  }

  /** 全量事件副本(审计用)。 */
  getEvents(): Event[] {
    return [...this.events];
  }

  /**
   * 断线重连补发:返回 seq 大于 afterSeq 的所有 Event。客户端重连带上它见过的
   * 最后 seq,服务端补齐之后的历史再转入实时。只补 Event 不补 Delta。
   */
  getEventsSince(afterSeq: number): Event[] {
    return this.events.filter((e) => e.seq > afterSeq);
  }
}

/**
 * 投影:事件流 → Message[](喂 LLM 的下游格式)。纯函数,不读时钟、无副作用。
 *
 * 三件非平凡的事:
 *  - 过滤:error/finished/interrupted 对 LLM 无意义,不产出 Message
 *  - 折叠:Anthropic 要求同一轮的 thinking block 与 text/tool_use 在同一条
 *    assistant message 里且 thinking 在前。事件流里 thinking_finished 是独立
 *    一条,故投影时挂起、并入随后的 agent_message;若其后无 agent_message
 *    (纯思考轮,罕见),单独产出一条只含 thinking 的 message。签名为空的
 *    thinking block 一律丢弃(无签名回传必 400)。
 *  - 注入窗口:Anthropic 要求 tool_result 紧随其配对的 tool_use。若用户消息落在
 *    「tool_use 已入流、tool_result 未齐」的窗口,直译会插进配对中间 → 400。
 *    故追踪未闭合的 tool_use id(open set),窗口期的 user_message 暂存,
 *    配对全闭合后按原顺序产出;流尾仍未闭合(仅进程崩溃可能)兜底原样 flush。
 */
export function projectToMessages(events: Event[]): Message[] {
  const msgs: Message[] = [];
  // 挂起的思考块：等待并入随后的 agent_message
  let pendingThinking: ThinkingBlock[] = [];
  // 注入窗口：未闭合的 tool_use id 集合 + 窗口期暂存的用户消息(保序)
  const openToolCalls = new Set<string>();
  let deferredUserTexts: string[] = [];

  // 把挂起的思考块单独产出一条 assistant message(仅当后面没有 agent_message 承接)
  const flushLoneThinking = () => {
    if (pendingThinking.length) {
      msgs.push({ role: "assistant", thinkingBlocks: pendingThinking });
      pendingThinking = [];
    }
  };

  // 配对闭合(或流尾兜底)后，把窗口期暂存的用户消息按原顺序产出
  const flushDeferredUsers = () => {
    for (const text of deferredUserTexts) {
      msgs.push({ role: "user", text });
    }
    deferredUserTexts = [];
  };

  for (const e of events) {
    switch (e.type) {
      case "user_message":
        // 注入窗口内：暂存，等配对闭合后产出(不能插进 tool_use/tool_result 之间)
        if (openToolCalls.size > 0) {
          deferredUserTexts.push(e.text);
          break;
        }
        flushLoneThinking(); // 轮次切换，孤立思考先落地
        msgs.push({ role: "user", text: e.text });
        break;
      case "thinking_finished": {
        // 兜底：丢弃无签名的块(回传会 400)
        const signed = e.blocks.filter((b) => b.signature);
        pendingThinking.push(...signed);
        break;
      }
      case "agent_message": {
        const thinking = pendingThinking;
        pendingThinking = [];
        // 防御：空 assistant 消息(无 thinking 无 text 无 toolCalls)会 400，跳过
        if (thinking.length || e.text || e.toolCalls.length) {
          msgs.push({
            role: "assistant",
            text: e.text || undefined,
            toolCalls: e.toolCalls.length ? e.toolCalls : undefined,
            thinkingBlocks: thinking.length ? thinking : undefined,
          });
        }
        // 开启注入窗口：登记本轮待配对的 tool_use id
        for (const tc of e.toolCalls) openToolCalls.add(tc.id);
        break;
      }
      case "tool_result":
        flushLoneThinking();
        msgs.push({
          role: "tool",
          toolResult: {
            toolCallId: e.toolCallId,
            content: e.content,
            isError: e.isError,
          },
        });
        // 关闭配对；本轮全部闭合 → 产出窗口期暂存的用户消息
        openToolCalls.delete(e.toolCallId);
        if (openToolCalls.size === 0) flushDeferredUsers();
        break;
      case "error":
      case "finished":
      case "interrupted":
        // 对 LLM 无意义，过滤掉(interrupted 的痕迹由检查点③的补偿 tool_result 承载)
        break;
    }
  }
  flushLoneThinking(); // 收尾：末尾若还挂着思考块，落地
  flushDeferredUsers(); // 兜底：流尾配对仍未闭合(仅进程崩溃可能)，原样产出不丢消息
  return msgs;
}
