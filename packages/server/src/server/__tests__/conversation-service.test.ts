import { describe, it, expect, vi } from "vitest";
import {
  DefaultConversationService,
  ConversationExistsError,
  ConversationNotFoundError,
  InvalidConversationInputError,
} from "../conversation-service.js";
import {
  AgentSession,
  makeAgentSessionFactory,
  type SessionFactory,
} from "../agent-session.js";
import { FsConversationStore } from "../../conversation/conversation-store.js";
import { Conversation } from "../../conversation/conversation.js";
import { findUnmatchedToolCalls } from "../../conversation/events.js";
import type { Event } from "../../conversation/events.js";
import type { ToolCall } from "../../llm/types.js";
import type { Runtime } from "../../runtime/runtime.js";
import type { LLMClient } from "../../llm/llm-client.js";
import type { LLMResponse } from "../../llm/types.js";
import { FsRunLogStore } from "../../observability/run-log-store.js";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ConversationService 持久化与恢复的端到端集成测试。
 *
 * 与 router.test.ts 的区别:那里 mock 掉整个 SessionFactory,只测 HTTP 参数传递;
 * 这里用「真 Conversation + 真 FsConversationStore + spy Runtime」装配,真正走 emit→落盘、
 * 崩溃(丢实例)→ 新进程 getOrResume→读回历史 的完整链路。对应设计文档 §6 验收
 * 1/5/6/7/8/9 —— 这些靠单元测试无法覆盖(单元层只验了 load/emit/findUnmatched 的零件,
 * 没验 manager 把它们串起来后真的能崩溃恢复)。
 *
 * agent 不真跑(LLM 不调):「跑了一轮」由测试直接 conversation.emit 模拟 —— emit 是
 * 落盘入口,调它即事件真落盘,比 mock agent 更直接地压持久化链路。
 */

const TC: ToolCall = { id: "tc-1", name: "run_bash", args: { command: "echo hi" } };

/**
 * 真实装配的 SessionFactory:用真 Conversation(真 EventStream + 真 FsConversationStore),
 * runtime 用 spy(记录 create 调用次数 → 验收 6/7:惰性化、读历史零 runtime),
 * agent 用 stub(不真跑)。createCalls/factoryCalls 供测试断言「是否起了容器」「是否装配」。
 */
function makeRealFactory(conversationStore: FsConversationStore) {
  const createCalls = new Map<string, number>();
  const killCalls = new Map<string, number>();
  const sessions = new Map<string, AgentSession>();
  let factoryCalls = 0;
  const factory: SessionFactory = async ({
    conversationId,
    workspaceDir,
    initialEvents,
    initialRecord,
  }) => {
    factoryCalls++;
    createCalls.set(conversationId, 0);
    killCalls.set(conversationId, 0);
    const runtime = {
      create: async () => {
        createCalls.set(
          conversationId,
          (createCalls.get(conversationId) ?? 0) + 1
        );
      },
      kill: async () => {
        killCalls.set(
          conversationId,
          (killCalls.get(conversationId) ?? 0) + 1
        );
      },
    } as unknown as Runtime;
    const conversation = new Conversation(conversationId, {
      store: conversationStore,
      initialEvents,
    });
    const session = new AgentSession({
      conversationId,
      conversation,
      agent: {} as never,
      journal: {} as never,
      runtime,
      conversationCreatedAt: initialRecord?.createdAt ?? Date.now(),
    });
    sessions.set(conversationId, session);
    return session;
  };
  return {
    factory,
    sessions,
    createCalls,
    killCalls,
    getFactoryCalls: () => factoryCalls,
  };
}

/** 起一个新 manager(模拟一个新进程),共享同一 workspaceRoot = 同一份磁盘事件。 */
function newManager(workspaceRoot: string) {
  const conversationStore = new FsConversationStore(workspaceRoot);
  const { factory, sessions, createCalls, killCalls, getFactoryCalls } =
    makeRealFactory(conversationStore);
  const service = new DefaultConversationService({
    workspaceRoot,
    createSession: factory,
    conversationStore,
  });
  const manager = testFacade(service, sessions);
  return {
    manager,
    service,
    conversationStore,
    sessions,
    createCalls,
    killCalls,
    getFactoryCalls,
  };
}

function testFacade(
  service: DefaultConversationService,
  sessions: Map<string, AgentSession>
) {
  return {
    async create(id?: string, tools?: string[]): Promise<AgentSession> {
      const info = await service.create({ conversationId: id, tools });
      return sessions.get(info.conversationId)!;
    },
    async getOrResume(id: string): Promise<AgentSession | undefined> {
      try {
        const subscription = await service.events(id);
        await subscription.close();
        return sessions.get(id);
      } catch (err) {
        if (err instanceof ConversationNotFoundError) return undefined;
        throw err;
      }
    },
    async destroy(id: string): Promise<boolean> {
      try {
        await service.delete(id);
        return true;
      } catch (err) {
        if (err instanceof ConversationNotFoundError) return false;
        throw err;
      }
    },
    list: () => service.list(),
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "tinyhands-resume-test-"));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** 事件指纹:只比 type+seq,够验「恢复后历史与崩溃前一致 + 续号正确」。 */
function fingerprint(events: Event[]) {
  return events.map((e) => ({ type: e.type, seq: e.seq }));
}

describe("ConversationService 持久化与恢复", () => {
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
    expect(summaries.map((s) => s.conversationId).sort()).toEqual(["a", "b", "c"]);
    expect(summaries.every((s) => !s.running)).toBe(true);
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

  it("恢复时为未提交 checkpoint 的 compaction 补 process_restarted cancelled", async () => {
    const root = tmpRoot();
    const m1 = newManager(root);
    const s1 = await m1.manager.create("c1");
    await s1.conversation.emit({
      type: "user_message",
      source: "user",
      text: "hi",
    });
    await s1.conversation.emit({
      type: "compaction_started",
      source: "agent",
      compactionId: "cmp-1",
      reason: "threshold",
      estimatedTokens: 100,
      triggerTokens: 80,
    });

    const m2 = newManager(root);
    const s2 = await m2.manager.getOrResume("c1");
    expect(s2!.conversation.getEvents().at(-1)).toMatchObject({
      type: "compaction_cancelled",
      compactionId: "cmp-1",
      reason: "process_restarted",
    });
  });

  it("恢复时 checkpoint 已提交但 completed 缺失则补 completed", async () => {
    const root = tmpRoot();
    const m1 = newManager(root);
    const s1 = await m1.manager.create("c1");
    await s1.conversation.emit({
      type: "user_message",
      source: "user",
      text: "old",
    });
    await s1.conversation.emit({
      type: "compaction_started",
      source: "agent",
      compactionId: "cmp-1",
      reason: "threshold",
      estimatedTokens: 100,
      triggerTokens: 80,
    });
    await s1.conversation.emit({
      type: "compacted",
      source: "agent",
      compactionId: "cmp-1",
      throughSeq: 1,
      summaryVersion: 1,
      summary: {
        objective: "goal",
        confirmedDecisions: [],
        constraints: [],
        completedWork: [],
        currentState: [],
        importantArtifacts: [],
        unresolvedIssues: [],
        nextActions: [],
      },
      provider: "test",
      model: "model",
      estimatedBeforeTokens: 100,
      estimatedAfterTokens: 40,
    });

    const m2 = newManager(root);
    const s2 = await m2.manager.getOrResume("c1");
    expect(s2!.conversation.getEvents().at(-1)).toMatchObject({
      type: "compaction_completed",
      compactionId: "cmp-1",
      throughSeq: 1,
      estimatedBeforeTokens: 100,
      estimatedAfterTokens: 40,
    });
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

  it("空 conversation 重启后仍可 list 与 resume", async () => {
    const root = tmpRoot();
    const m1 = newManager(root);
    await m1.manager.create("empty");

    const m2 = newManager(root);
    expect(await m2.manager.list()).toContainEqual(
      expect.objectContaining({
        conversationId: "empty",
        running: false,
      })
    );
    expect(await m2.manager.getOrResume("empty")).toBeDefined();
    expect(m2.createCalls.get("empty")).toBe(0);
  });

  it("删除未驻留的磁盘 conversation 返回 true 且不可恢复", async () => {
    const root = tmpRoot();
    const m1 = newManager(root);
    const session = await m1.manager.create("c1");
    await session.conversation.emit({
      type: "user_message",
      source: "user",
      text: "persist me",
    });

    const m2 = newManager(root);
    expect(await m2.manager.destroy("c1")).toBe(true);
    expect(existsSync(join(root, "c1"))).toBe(false);
    expect(await m2.manager.getOrResume("c1")).toBeUndefined();
  });

  it("并发 create 同一 id 只有一个成功", async () => {
    const root = tmpRoot();
    const manager = newManager(root);

    const results = await Promise.allSettled([
      manager.manager.create("same"),
      manager.manager.create("same"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.any(ConversationExistsError),
    });
    expect(manager.getFactoryCalls()).toBe(1);
  });

  it("resume 与 destroy 竞争后不会把已删除 session 放回内存", async () => {
    const root = tmpRoot();
    const m1 = newManager(root);
    const persisted = await m1.manager.create("c1");
    await persisted.conversation.emit({
      type: "user_message",
      source: "user",
      text: "persist me",
    });

    const conversationStore = new FsConversationStore(root);
    const base = makeRealFactory(conversationStore);
    const resumeStarted = deferred();
    const allowResume = deferred();
    const delayedFactory: SessionFactory = async (opts) => {
      if (opts.initialEvents) {
        resumeStarted.resolve();
        await allowResume.promise;
      }
      return base.factory(opts);
    };
    const service = new DefaultConversationService({
      workspaceRoot: root,
      createSession: delayedFactory,
      conversationStore,
    });
    const manager = testFacade(service, base.sessions);

    const resume = manager.getOrResume("c1");
    await resumeStarted.promise;
    const destroy = manager.destroy("c1");
    allowResume.resolve();

    await resume;
    expect(await destroy).toBe(true);
    expect(await manager.getOrResume("c1")).toBeUndefined();
    expect(existsSync(join(root, "c1"))).toBe(false);
  });

  it("直接调用 Service 也不能绕过 conversationId 与 tools 校验", async () => {
    const root = tmpRoot();
    const { service } = newManager(root);

    await expect(
      service.create({ conversationId: "../escape" })
    ).rejects.toBeInstanceOf(InvalidConversationInputError);
    await expect(
      service.create({ conversationId: "safe", tools: ["unknown_tool"] })
    ).rejects.toBeInstanceOf(InvalidConversationInputError);
    expect(existsSync(join(root, "safe"))).toBe(false);
  });

  it("delete 等待后台 driver 退出，成功后迟到 error 不会重建目录", async () => {
    const root = tmpRoot();
    const conversationStore = new FsConversationStore(root);
    let rejectChat: ((error: Error) => void) | undefined;
    const chat = vi.fn<LLMClient["chat"]>(
      async () =>
        await new Promise<LLMResponse>((_resolve, reject) => {
          rejectChat = reject;
        })
    );
    const createSession = makeAgentSessionFactory({
      llm: {
        identity: { provider: "test", model: "model", apiMode: "messages" },
        chat,
      },
      maxStep: 2,
      runtime: { type: "local" },
      conversationStore,
      runLogStore: new FsRunLogStore(root),
    });
    const service = new DefaultConversationService({
      workspaceRoot: root,
      createSession,
      conversationStore,
    });
    await service.create({ conversationId: "c1", tools: [] });
    await service.send("c1", "hello");
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));

    let deleted = false;
    const deleting = service.delete("c1").then(() => {
      deleted = true;
    });
    await Promise.resolve();
    expect(deleted).toBe(false);
    expect(existsSync(join(root, "c1"))).toBe(true);

    rejectChat?.(new Error("late failure"));
    await deleting;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(existsSync(join(root, "c1"))).toBe(false);
  });

  it("close 幂等释放 resident Session，但保留持久 Conversation", async () => {
    const root = tmpRoot();
    const first = newManager(root);
    await first.service.create({ conversationId: "c1", tools: [] });

    await Promise.all([first.service.close(), first.service.close()]);

    expect(first.killCalls.get("c1")).toBe(1);
    expect(existsSync(join(root, "c1", "meta.json"))).toBe(true);
    await expect(first.service.create({ conversationId: "later" })).rejects.toThrow(
      /已关闭|正在关闭/
    );

    const restarted = newManager(root);
    expect(await restarted.service.list()).toContainEqual(
      expect.objectContaining({ conversationId: "c1", running: false })
    );
  });
});
