import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsEventStore } from "../event-store.js";
import type { Event } from "../events.js";

/**
 * FsEventStore 测试 —— 落盘/读回往返、坏尾截断、seq 缺口、list/remove。
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

describe("FsEventStore", () => {
  let root: string;
  let store: FsEventStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "tinyhands-store-test-"));
    store = new FsEventStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("append → load 往返一致(顺序与内容)", async () => {
    const id = "conv-a";
    await store.append(id, evt(1));
    await store.append(id, evt(2));
    await store.append(id, evt(3));

    const loaded = await store.load(id);
    expect(loaded.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(loaded[1]).toMatchObject({ type: "user_message", text: "msg-2" });
  });

  it("load 不存在的会话返回 [](不抛错)", async () => {
    expect(await store.load("nope")).toEqual([]);
  });

  it("坏尾:末行写成半条 JSON → 截断,返回干净前缀", async () => {
    const id = "conv-bad";
    await store.append(id, evt(1));
    await store.append(id, evt(2));
    // 手工追加一行坏 JSON(模拟崩溃写一半)
    await appendFile(join(root, id, "events.jsonl"), '{"type":"user_mess');

    const loaded = await store.load(id);
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

    const loaded = await store.load(id);
    expect(loaded.map((e) => e.seq)).toEqual([1, 2]); // seq=4 处发现缺口,截断
  });

  it("list:只返回含 events.jsonl 的会话目录", async () => {
    await store.append("conv-1", evt(1));
    await store.append("conv-2", evt(1));
    // 一个只有 workspace、没有 events.jsonl 的目录,不算持久化会话
    mkdirSync(join(root, "conv-empty-workspace"), { recursive: true });

    const ids = await store.list();
    expect(ids.sort()).toEqual(["conv-1", "conv-2"]);
  });

  it("remove:删除后 load 返回 []", async () => {
    const id = "conv-rm";
    await store.append(id, evt(1));
    expect((await store.load(id)).length).toBe(1);

    await store.remove(id);
    expect(await store.load(id)).toEqual([]);
    expect((await store.list()).includes(id)).toBe(false);
  });

  it("remove 幂等:删除不存在的会话不报错", async () => {
    await expect(store.remove("never-existed")).resolves.toBeUndefined();
  });

  it("saveMeta → loadMeta 往返一致", async () => {
    const id = "conv-meta";
    const meta = { createdAt: 1700000000000, tools: ["run_bash", "run_code"] };
    await store.saveMeta(id, meta);

    const loaded = await store.loadMeta(id);
    expect(loaded).toEqual(meta);
  });

  it("loadMeta 不存在返回 undefined", async () => {
    expect(await store.loadMeta("nope")).toBeUndefined();
  });

  it("loadMeta 坏 JSON 返回 undefined(不抛错,退化用默认)", async () => {
    const id = "conv-bad-meta";
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "meta.json"), "{broken");
    expect(await store.loadMeta(id)).toBeUndefined();
  });
});
