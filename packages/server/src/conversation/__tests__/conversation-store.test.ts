import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConversationRecordExistsError,
  ConversationRecoveryError,
  FsConversationStore,
} from "../conversation-store.js";
import type { Event } from "../events.js";

/**
 * FsConversationStore 测试 —— record、事件往返、坏尾截断、list/delete 与迁移。
 * 对应设计 §6 验收 #1(往返)/ #4(坏尾)/ #9(destroy 删事件)。
 */

/** 构造一条最小合法 Event(带 seq,供 append/load 往返)。 */
function evt(seq: number, type: Event["type"] = "user_message"): Event {
  const base = {
    id: `evt-${seq}`,
    seq,
    timestamp: 1700000000000 + seq,
    source: "user" as const,
  };
  switch (type) {
    case "user_message":
      return { ...base, type: "user_message", text: `msg-${seq}` };
    case "agent_message":
      return { ...base, type: "agent_message", text: `a-${seq}`, toolCalls: [] };
    case "tool_result":
      return {
        ...base,
        type: "tool_result",
        toolCallId: `tc-${seq}`,
        content: `c-${seq}`,
        isError: false,
      };
    default:
      return { ...base, type, text: `x-${seq}` } as Event;
  }
}

describe("FsConversationStore", () => {
  let root: string;
  let store: FsConversationStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tinyhands-store-test-"));
    store = new FsConversationStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("append → load 往返一致(顺序与内容)", async () => {
    const id = "conv-a";
    await store.appendEvent(id, evt(1));
    await store.appendEvent(id, evt(2));
    await store.appendEvent(id, evt(3));

    const loaded = (await store.load(id))!.events;
    expect(loaded.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(loaded[1]).toMatchObject({ type: "user_message", text: "msg-2" });
  });

  it("providerReplay 与 canonical agent_message 同一条 JSONL 往返", async () => {
    const event: Event = {
      id: "evt-1",
      seq: 1,
      timestamp: 1,
      source: "agent",
      type: "agent_message",
      text: "canonical",
      toolCalls: [],
      providerReplay: {
        kind: "openai_responses",
        version: 1,
        scope: {
          provider: "openai",
          apiMode: "responses",
          model: "gpt-test",
          endpointHash: "hash",
        },
        items: [
          {
            type: "reasoning",
            id: "rs-1",
            summary: [],
            encryptedContent: "ciphertext",
          },
        ],
      },
    };

    await store.appendEvent("conv-replay", event);
    expect((await store.load("conv-replay"))!.events).toEqual([event]);
  });

  it("load 不存在的会话返回 [](不抛错)", async () => {
    expect(await store.load("nope")).toBeUndefined();
  });

  it("坏尾:末行写成半条 JSON → 截断,返回干净前缀", async () => {
    const id = "conv-bad";
    await store.appendEvent(id, evt(1));
    await store.appendEvent(id, evt(2));
    // 手工追加一行坏 JSON(模拟崩溃写一半)
    await appendFile(join(root, id, "events.jsonl"), '{"type":"user_mess');

    const loaded = (await store.load(id))!.events;
    expect(loaded.map((e) => e.seq)).toEqual([1, 2]); // 坏行被丢弃
  });

  it("seq 缺口:跳号 → 在缺口处截断,丢弃之后", async () => {
    const id = "conv-gap";
    const file = join(root, id, "events.jsonl");
    mkdirSync(join(root, id), { recursive: true });
    // 手工写 seq=1, seq=2, seq=4(跳过 3)
    writeFileSync(
      file,
      [evt(1), evt(2), evt(4)].map((e) => JSON.stringify(e)).join("\n") + "\n"
    );

    const loaded = (await store.load(id))!.events;
    expect(loaded.map((e) => e.seq)).toEqual([1, 2]); // seq=4 处发现缺口,截断
  });

  it("list:只返回含 events.jsonl 的会话目录", async () => {
    await store.appendEvent("conv-1", evt(1));
    await store.appendEvent("conv-2", evt(1));
    // 一个只有 workspace、没有 events.jsonl 的目录,不算持久化会话
    mkdirSync(join(root, "conv-empty-workspace"), { recursive: true });

    const ids = (await store.list()).map((record) => record.conversationId);
    expect(ids.sort()).toEqual(["conv-1", "conv-2"]);
  });

  it("remove:删除后 load 返回 []", async () => {
    const id = "conv-rm";
    await store.appendEvent(id, evt(1));
    expect((await store.load(id))!.events).toHaveLength(1);

    await store.delete(id);
    expect(await store.load(id)).toBeUndefined();
    expect((await store.list()).some((record) => record.conversationId === id)).toBe(
      false
    );
  });

  it("remove 幂等:删除不存在的会话不报错", async () => {
    await expect(store.delete("never-existed")).resolves.toBeUndefined();
  });

  it("create → load 往返 schema record", async () => {
    const id = "conv-meta";
    const record = {
      schemaVersion: 1 as const,
      conversationId: id,
      createdAt: 1700000000000,
      tools: ["run_bash", "run_code"],
    };
    await store.create(record);

    expect((await store.load(id))?.record).toEqual(record);
  });

  it("create 使用排他语义，同一 record 不能覆盖", async () => {
    const record = {
      schemaVersion: 1 as const,
      conversationId: "same",
      createdAt: 1,
    };
    await store.create(record);
    await expect(store.create(record)).rejects.toBeInstanceOf(
      ConversationRecordExistsError
    );
  });

  it("meta.json 损坏时明确恢复失败，不静默退化", async () => {
    const id = "conv-bad-meta";
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "meta.json"), "{broken");
    await expect(store.load(id)).rejects.toBeInstanceOf(ConversationRecoveryError);
  });

  it("旧 meta 自动升级为带 schemaVersion 与 identity 的 record", async () => {
    const id = "conv-legacy-meta";
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(
      join(root, id, "meta.json"),
      JSON.stringify({ createdAt: 123, tools: ["run_bash"] })
    );

    expect((await store.load(id))?.record).toEqual({
      schemaVersion: 1,
      conversationId: id,
      createdAt: 123,
      tools: ["run_bash"],
    });
  });
});
