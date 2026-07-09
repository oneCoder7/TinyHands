import { describe, it, expect } from "vitest";
import {
  ConversationManager,
  ConversationExistsError,
} from "../conversation-manager.js";
import type { SessionFactory } from "../agent-session.js";
import { FsEventStore } from "../../conversation/event-store.js";
import { Conversation } from "../../conversation/conversation.js";
import { findUnmatchedToolCalls } from "../../conversation/events.js";
import type { Event } from "../../conversation/events.js";
import type { ToolCall } from "../../llm/types.js";
import type { Runtime } from "../../runtime/runtime.js";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ConversationManager 持久化与恢复的端到端集成测试。
 *
 * 与 router.test.ts 的区别:那里 mock 掉整个 SessionFactory,只测 HTTP 参数传递;
 * 这里用「真 Conversation + 真 FsEventStore + spy Runtime」装配,真正走 emit→落盘、
 * 崩溃(丢实例)→ 新进程 getOrResume→读回历史 的完整链路。对应设计文档 §6 验收
 * 1/5/6/7/8/9 —— 这些靠单元测试无法覆盖(单元层只验了 load/emit/findUnmatched 的零件,
 * 没验 manager 把它们串起来后真的能崩溃恢复)。
 *
 * agent 不真跑(LLM 不调):「跑了一轮」由测试直接 conversation.emit 模拟 —— emit 是
 * 落盘入口,调它即事件真落盘,比 mock agent 更直接地压持久化链路。
 */

const TC: ToolCall = { id: "tc-1", name: "run_bash", args: { command: "echo hi" } };

/**
 * 真实装配的 SessionFactory:用真 Conversation(真 EventStream + 真 FsEventStore),
 * runtime 用 spy(记录 create 调用次数 → 验收 6/7:惰性化、读历史零 runtime),
 * agent 用 stub(不真跑)。createCalls/factoryCalls 供测试断言「是否起了容器」「是否装配」。
 */
function makeRealFactory(eventStore: FsEventStore) {
  const createCalls = new Map<string, number>();
  let factoryCalls = 0;
  const factory: SessionFactory = async ({
    conversationId,
    workspaceDir,
    initialEvents,
    initialMeta,
  }) => {
    factoryCalls++;
    createCalls.set(conversationId, 0);
    const runtime = {
      create: async () => {
        createCalls.set(
          conversationId,
          (createCalls.get(conversationId) ?? 0) + 1
        );
      },
      kill: async () => {},
    } as unknown as Runtime;
    const conversation = new Conversation(conversationId, runtime, {
      store: eventStore,
      initialEvents,
    });
    return {
      conversationId,
      conversation,
      agent: {} as never,
      workspaceDir,
      createdAt: initialMeta?.createdAt ?? Date.now(),
      running: false,
      runAbort: null,
      runtimeStarted: false,
    };
  };
  return { factory, createCalls, getFactoryCalls: () => factoryCalls };
}

/** 起一个新 manager(模拟一个新进程),共享同一 workspaceRoot = 同一份磁盘事件。 */
function newManager(workspaceRoot: string) {
  const eventStore = new FsEventStore(workspaceRoot);
  const { factory, createCalls, getFactoryCalls } = makeRealFactory(eventStore);
  const manager = new ConversationManager({
    workspaceRoot,
    createSession: factory,
    eventStore,
  });
  return { manager, eventStore, createCalls, getFactoryCalls };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tinyhands-resume-test-"));
}

/** 事件指纹:只比 type+seq,够验「恢复后历史与崩溃前一致 + 续号正确」。 */
function fingerprint(events: Event[]) {
  return events.map((e) => ({ type: e.type, seq: e.seq }));
}

describe("ConversationManager 持久化与恢复", () => {
  it("create 后不发消息,不触发 runtime.create(§6 验收6)", async () => {
    const root = tmpRoot();
    const { manager, createCalls } = newManager(root);
    const session = await manager.create("c1");
    expect(createCalls.get("c1")).toBe(0);
    expect(session.runtimeStarted).toBe(false);
  });

  it("崩溃→重启→getOrResume 拿回完整历史并续号(§6 验收1)", async () => {
    const root = tmpRoot();
    const m1 = newManager(root);
    const s1 = await m1.manager.create("c1");
    // 模拟 agent 跑了一轮:一串事件真落盘
    await s1.conversation.emit({
      type: "user_message",
      source: "user",
      text: "数文件",
    });
    await s1.conversation.emit({
      type: "thinking_finished",
      source: "agent",
      blocks: [{ thinking: "想一下", signature: "sig-1" }],
    });
    await s1.conversation.emit({
      type: "agent_message",
      source: "agent",
      text: "好的",
      toolCalls: [TC],
    });
    await s1.conversation.emit({
      type: "tool_result",
      source: "environment",
      toolCallId: "tc-1",
      content: "3",
      isError: false,
    });
    await s1.conversation.emit({
      type: "finished",
      source: "agent",
      result: "done",
    });

    const before = fingerprint(s1.conversation.getEvents());
    expect(before.length).toBe(5);

    // 模拟崩溃:丢 m1(内存全没),新进程同 workspaceRoot 起 m2
    const m2 = newManager(root);
    const s2 = await m2.manager.getOrResume("c1");
    expect(s2).toBeDefined();

    const after = fingerprint(s2!.conversation.getEvents());
    expect(after).toEqual(before);

    // 续号:恢复后下一条 emit 应是 seq 6(events.length=5 → +1)
    const e6 = await s2!.conversation.emit({
      type: "user_message",
      source: "user",
      text: "再来",
    });
    expect(e6.seq).toBe(6);
  });

  it("恢复全程零 runtime.create(§6 验收7 恢复侧)", async () => {
    const root = tmpRoot();
    const m1 = newManager(root);
    const s1 = await m1.manager.create("c1");
    await s1.conversation.emit({
      type: "user_message",
      source: "user",
      text: "hi",
    });

    const m2 = newManager(root);
    await m2.manager.getOrResume("c1");
    expect(m2.createCalls.get("c1")).toBe(0); // 恢复纯读,不起容器
    expect(m2.getFactoryCalls()).toBe(1); // 装配一次(用来续聊)
  });

  it("list 大量空闲会话零 runtime.create、不装配(§6 验收7)", async () => {
    const root = tmpRoot();
    const m1 = newManager(root);
    for (const id of ["a", "b", "c"]) {
      const s = await m1.manager.create(id);
      await s.conversation.emit({
        type: "user_message",
        source: "user",
        text: id,
      });
    }

    // 崩溃 + 新进程:list 只读磁盘,不装配任何会话
    const m2 = newManager(root);
    const summaries = await m2.manager.list();
    const diskOnly = summaries.filter((s) => !s.resident);
    expect(diskOnly.map((s) => s.conversationId).sort()).toEqual(["a", "b", "c"]);
    expect(m2.getFactoryCalls()).toBe(0); // list 纯读,零装配 → 零 runtime
  });

  it("恢复后 running=false 且 runtime 未起,不自动续跑(§6 验收8)", async () => {
    const root = tmpRoot();
    const m1 = newManager(root);
    const s1 = await m1.manager.create("c1");
    await s1.conversation.emit({
      type: "user_message",
      source: "user",
      text: "hi",
    });

    const m2 = newManager(root);
    const s2 = await m2.manager.getOrResume("c1");
    // manager 不认识 driveRun(那是 submitUserMessage 的职责);getOrResume 只装配,
    // 从不触发 run。故恢复后 running=false、runtime 未起 → 物理上无法续跑。
    expect(s2!.running).toBe(false);
    expect(s2!.runtimeStarted).toBe(false);
  });

  it("destroy 删 events.jsonl + workspace,不可恢复(§6 验收9)", async () => {
    const root = tmpRoot();
    const { manager } = newManager(root);
    const s = await manager.create("c1");
    await s.conversation.emit({
      type: "user_message",
      source: "user",
      text: "hi",
    });
    const dir = join(root, "c1");
    expect(existsSync(join(dir, "events.jsonl"))).toBe(true);

    await manager.destroy("c1");

    expect(existsSync(dir)).toBe(false);
    // 新进程也恢复不出来
    const m2 = newManager(root);
    expect(await m2.manager.getOrResume("c1")).toBeUndefined();
  });

  it("孤儿 tool_use 恢复时补偿 error tool_result(§6 验收5,整链路)", async () => {
    const root = tmpRoot();
    const m1 = newManager(root);
    const s1 = await m1.manager.create("c1");
    // 崩在「tool_use 已落盘、tool_result 未落盘」窗口:emit 到 agent_message 就停
    await s1.conversation.emit({
      type: "user_message",
      source: "user",
      text: "跑命令",
    });
    await s1.conversation.emit({
      type: "agent_message",
      source: "agent",
      text: "",
      toolCalls: [TC],
    });

    const m2 = newManager(root);
    const s2 = await m2.manager.getOrResume("c1");
    const events = s2!.conversation.getEvents();

    // 末尾应是 manager 自动补偿的 error tool_result
    const last = events.at(-1)!;
    expect(last.type).toBe("tool_result");
    expect(last).toMatchObject({
      toolCallId: "tc-1",
      isError: true,
    });
    // 补偿后无孤儿 → 重投影喂 Anthropic 不会 400
    expect(findUnmatchedToolCalls(events)).toEqual([]);
    expect(() => s2!.conversation.toMessages()).not.toThrow();
  });

  it("磁盘 id 冲突:create 已存在的磁盘 id 抛 ConversationExistsError", async () => {
    const root = tmpRoot();
    const m1 = newManager(root);
    const s1 = await m1.manager.create("c1");
    await s1.conversation.emit({
      type: "user_message",
      source: "user",
      text: "hi",
    });

    const m2 = newManager(root);
    await expect(m2.manager.create("c1")).rejects.toBeInstanceOf(
      ConversationExistsError
    );
  });

  it("getOrResume 不存在的 id → undefined", async () => {
    const root = tmpRoot();
    const { manager } = newManager(root);
    expect(await manager.getOrResume("nope")).toBeUndefined();
  });

  it("并发 getOrResume 同一 id 复用同一 load(加载锁)", async () => {
    const root = tmpRoot();
    const m1 = newManager(root);
    const s1 = await m1.manager.create("c1");
    await s1.conversation.emit({
      type: "user_message",
      source: "user",
      text: "hi",
    });

    const m2 = newManager(root);
    const [a, b] = await Promise.all([
      m2.manager.getOrResume("c1"),
      m2.manager.getOrResume("c1"),
    ]);
    expect(a).toBe(b); // 复用同一 load Promise → 同一实例
    expect(m2.getFactoryCalls()).toBe(1); // 只装配一次,不重复 load
  });
});
