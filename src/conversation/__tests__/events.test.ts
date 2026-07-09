import { describe, it, expect, vi } from "vitest";
import {
  EventStream,
  findUnmatchedToolCalls,
  projectToMessages,
  type Event,
  type EventDraft,
} from "../events.js";
import type { EventStore } from "../event-store.js";
import type { Delta } from "../../llm/types.js";

/**
 * EventStream 持久化行为测试 + findUnmatchedToolCalls 恢复补偿测试。
 * 对应设计 §6 验收 #2(落盘失败不广播)/ #3(delta 不落盘)/ #5(孤儿补偿)/ #8(恢复续号)。
 */

/** 一个可控的内存 EventStore:可注入落盘失败、记录调用。 */
function makeMockStore(): EventStore & {
  appended: Event[];
  failNext: number;
  appendCalls: number;
} {
  const appended: Event[] = [];
  return {
    appended,
    failNext: 0,
    appendCalls: 0,
    async append(_id: string, event: Event) {
      this.appendCalls++;
      if (this.failNext > 0) {
        this.failNext--;
        throw new Error("mock 落盘失败");
      }
      appended.push(event);
    },
    async load() {
      return [...appended];
    },
    async saveMeta() {},
    async loadMeta() {
      return undefined;
    },
    async list() {
      return ["c"];
    },
    async remove() {},
  } as any;
}

const draft = (text: string): EventDraft => ({
  type: "user_message",
  source: "user",
  text,
});

describe("EventStream 持久化", () => {
  it("emit 先落盘后广播:订阅者收到的事件已落盘", async () => {
    const store = makeMockStore();
    const stream = new EventStream(store, "c");
    const seen: Event[] = [];
    stream.subscribe((item) => {
      if ("delta" in item) return;
      seen.push(item);
    });

    await stream.emit(draft("hi"));

    expect(store.appended.length).toBe(1);
    expect(store.appended[0]).toMatchObject({ text: "hi" });
    expect(seen.length).toBe(1);
    expect(seen[0]!.seq).toBe(store.appended[0]!.seq); // 广播的 == 落盘的
  });

  it("emit 落盘失败 → 抛出、不 push 内存、不广播(真相源优先)", async () => {
    const store = makeMockStore();
    store.failNext = 1; // 第一次 append 抛错
    const stream = new EventStream(store, "c");
    const seen: Event[] = [];
    stream.subscribe((item) => {
      if ("delta" in item) return;
      seen.push(item);
    });

    await expect(stream.emit(draft("bad"))).rejects.toThrow("mock 落盘失败");
    expect(seen.length).toBe(0); // 未广播
    expect(stream.getEvents().length).toBe(0); // 未 push 内存
  });

  it("delta 不落盘、只广播(瞬态)", async () => {
    const store = makeMockStore();
    const stream = new EventStream(store, "c");
    const seen: (Event | { delta: Delta })[] = [];
    stream.subscribe((item) => seen.push(item));

    const delta: Delta = { kind: "thinking", phase: "start" };
    stream.emitDelta(delta); // 同步、不 await

    expect(store.appendCalls).toBe(0); // delta 绝不落盘
    expect(seen.length).toBe(1);
    expect(seen[0] && "delta" in seen[0]).toBe(true);
  });

  it("恢复:initialEvents 灌入,seq 从最大值续号", async () => {
    const store = makeMockStore();
    const initial: Event[] = [
      {
        id: "evt-1",
        seq: 1,
        timestamp: 1,
        source: "user",
        type: "user_message",
        text: "old",
      },
      {
        id: "evt-2",
        seq: 2,
        timestamp: 2,
        source: "user",
        type: "user_message",
        text: "older",
      },
    ];
    const stream = new EventStream(store, "c", initial);

    expect(stream.getEvents().length).toBe(2); // 灌入的可见
    const e = await stream.emit(draft("new"));
    expect(e.seq).toBe(3); // 从 seq=2 续号
  });

  it("串行队列:并发 emit 的落盘顺序 == 调用顺序", async () => {
    // 慢 store:每个 append 延迟递增,若不串行会乱序完成
    const order: string[] = [];
    const store: EventStore = {
      async append(_id, event) {
        const seq = (event as Event).seq;
        // seq 越大延迟越久 —— 若并发执行,大 seq 会先完成 → 顺序乱
        await new Promise((r) => setTimeout(r, 10 - seq));
        order.push(`s${seq}`);
      },
      async load() {
        return [];
      },
      async saveMeta() {},
      async loadMeta() {
        return undefined;
      },
      async list() {
        return [];
      },
      async remove() {},
    };
    const stream = new EventStream(store, "c");

    // 并发发起 3 个 emit(不 await 之间)
    const p1 = stream.emit(draft("a"));
    const p2 = stream.emit(draft("b"));
    const p3 = stream.emit(draft("c"));
    await Promise.all([p1, p2, p3]);

    // 落盘顺序必须是 seq 升序(1,2,3),即便大 seq 的 append 延迟更短
    expect(order).toEqual(["s1", "s2", "s3"]);
  });

  it("落盘失败不留 seq 空洞(关键修复)", async () => {
    // 第 2 次 append 失败,第 3 次成功。磁盘应是 1,2 且 seq 连续。
    // 旧版本会留 1,3 缺口 → load 截断丢 3;新版本 seq 链内取,失败不 push,seq 连续。
    const store = makeMockStore();
    const stream = new EventStream(store, "c");

    await stream.emit(draft("a")); // seq=1 成功
    store.failNext = 1; // 下一次 append 失败
    await expect(stream.emit(draft("bad"))).rejects.toThrow("mock 落盘失败"); // seq=2 失败,不 push
    const e3 = await stream.emit(draft("c")); // seq 应=2(不是3),因前一条没 push
    expect(e3.seq).toBe(2); // 关键:seq 连续,无空洞
    expect(stream.getEvents().map((e) => e.seq)).toEqual([1, 2]);
    expect(store.appended.map((e) => e.seq)).toEqual([1, 2]); // 磁盘也连续
  });
});

describe("findUnmatchedToolCalls — 恢复时的孤儿补偿", () => {
  const tc = (id: string) => ({ id, name: "run_bash", args: {} });

  it("无孤儿:全部 tool_use 都有配对 tool_result → 返回空", () => {
    const events: Event[] = [
      {
        id: "e1",
        seq: 1,
        timestamp: 1,
        source: "agent",
        type: "agent_message",
        text: "",
        toolCalls: [tc("t1")],
      },
      {
        id: "e2",
        seq: 2,
        timestamp: 2,
        source: "environment",
        type: "tool_result",
        toolCallId: "t1",
        content: "ok",
        isError: false,
      },
    ];
    expect(findUnmatchedToolCalls(events)).toEqual([]);
  });

  it("有孤儿:tool_use 落盘但 tool_result 未落盘(崩溃窗口) → 返回孤儿", () => {
    const events: Event[] = [
      {
        id: "e1",
        seq: 1,
        timestamp: 1,
        source: "agent",
        type: "agent_message",
        text: "",
        toolCalls: [tc("t1"), tc("t2")],
      },
      // 只有 t1 配对,t2 是孤儿
      {
        id: "e2",
        seq: 2,
        timestamp: 2,
        source: "environment",
        type: "tool_result",
        toolCallId: "t1",
        content: "ok",
        isError: false,
      },
    ];
    const orphans = findUnmatchedToolCalls(events);
    expect(orphans.map((o) => o.id)).toEqual(["t2"]);
  });

  it("补偿后可投影:补 error tool_result → projectToMessages 不留孤儿", () => {
    const events: Event[] = [
      {
        id: "e1",
        seq: 1,
        timestamp: 1,
        source: "agent",
        type: "agent_message",
        text: "",
        toolCalls: [tc("t1")],
      },
    ];
    // 补偿:给孤儿 t1 配一条 error tool_result
    const orphans = findUnmatchedToolCalls(events);
    expect(orphans.length).toBe(1);
    const compensated: Event[] = [
      ...events,
      {
        id: "e2",
        seq: 2,
        timestamp: 2,
        source: "environment",
        type: "tool_result",
        toolCallId: orphans[0]!.id,
        content: "进程中断,该工具未完成执行",
        isError: true,
      },
    ];
    // 投影后,assistant 的 tool_use 与 tool 的 tool_result 必须成对
    const msgs = projectToMessages(compensated);
    const assistant = msgs.find((m) => m.role === "assistant");
    const tool = msgs.find((m) => m.role === "tool");
    expect(assistant?.toolCalls?.[0]?.id).toBe("t1");
    expect(tool?.toolResult?.toolCallId).toBe("t1");
  });

  it("去重:同 id 的 tool_use 出现多次(防御),只补一次", () => {
    const events: Event[] = [
      {
        id: "e1",
        seq: 1,
        timestamp: 1,
        source: "agent",
        type: "agent_message",
        text: "",
        toolCalls: [tc("t1")],
      },
      {
        id: "e2",
        seq: 2,
        timestamp: 2,
        source: "agent",
        type: "agent_message",
        text: "",
        toolCalls: [tc("t1")],
      },
    ];
    expect(findUnmatchedToolCalls(events).length).toBe(1);
  });
});
