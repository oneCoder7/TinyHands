import { appendFile, readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RunJournal,
  RunLogRecordSchema,
  type RunLogRecord,
} from "../run-log.js";
import { FsRunLogStore, type RunLogStore } from "../run-log-store.js";

class MemoryRunLogStore implements RunLogStore {
  records: RunLogRecord[] = [];
  failNextAppend = false;

  async loadAndRepair(): Promise<RunLogRecord[]> {
    return [...this.records];
  }

  async append(_conversationId: string, record: RunLogRecord): Promise<void> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("disk full");
    }
    this.records.push(record);
  }

  async remove(): Promise<void> {
    this.records = [];
  }
}

describe("RunJournal", () => {
  it("并发 append 仍按连续 seq 串行落盘", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        journal.append({ type: "run_started", runId: `run-${i}` })
      )
    );
    expect(store.records.map((record) => record.seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1)
    );
  });

  it("单次落盘失败不推进内存 seq，也不毒化后续链", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    store.failNextAppend = true;
    await expect(
      journal.append({ type: "run_started", runId: "failed" })
    ).rejects.toThrow("disk full");
    const record = await journal.append({ type: "run_started", runId: "ok" });
    expect(record.seq).toBe(1);
    expect(journal.getRecords()).toHaveLength(1);
  });

  it("恢复时为未闭合 run 追加 process_crashed，且不重复闭合", async () => {
    const store = new MemoryRunLogStore();
    const first = await RunJournal.open("c1", store);
    await first.append({ type: "run_started", runId: "open-run" });

    const recovered = await RunJournal.open("c1", store);
    await recovered.recoverOpenRuns();
    await recovered.recoverOpenRuns();

    expect(
      recovered.getRecords().filter((record) => record.type === "run_recovered")
    ).toHaveLength(1);
  });

  it("schema 拒绝正文等未声明字段", async () => {
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const record = await journal.append({ type: "run_started", runId: "run-1" });
    expect(
      RunLogRecordSchema.safeParse({ ...record, content: "must-not-persist" }).success
    ).toBe(false);
  });
});

describe("FsRunLogStore", () => {
  it("物理截断半条坏尾，修复后新记录仍可正常读取", async () => {
    const root = mkdtempSync(join(tmpdir(), "tinyhands-run-log-test-"));
    const store = new FsRunLogStore(root);
    const first = await RunJournal.open("c1", store);
    await first.append({ type: "run_started", runId: "run-1" });

    const file = join(root, "c1", "run_log.jsonl");
    await appendFile(file, '{"broken":', "utf8");

    const repaired = await RunJournal.open("c1", store);
    expect(repaired.getRecords()).toHaveLength(1);
    await repaired.append({
      type: "run_completed",
      runId: "run-1",
      status: "completed",
      projectedThroughSeq: 1,
      durationMs: 5,
    });

    const loaded = await store.loadAndRepair("c1");
    expect(loaded.map((record) => record.seq)).toEqual([1, 2]);
    expect(await readFile(file, "utf8")).not.toContain("broken");
  });

  it("遇到 seq 缺口时截断到有效前缀", async () => {
    const root = mkdtempSync(join(tmpdir(), "tinyhands-run-log-gap-test-"));
    const store = new FsRunLogStore(root);
    const first = await RunJournal.open("c1", store);
    const initial = await first.append({ type: "run_started", runId: "run-1" });
    const file = join(root, "c1", "run_log.jsonl");
    await appendFile(
      file,
      JSON.stringify({ ...initial, seq: 3, runId: "run-gap" }) + "\n",
      "utf8"
    );

    const repaired = await RunJournal.open("c1", store);
    expect(repaired.getRecords().map((record) => record.seq)).toEqual([1]);
    const next = await repaired.append({
      type: "run_completed",
      runId: "run-1",
      status: "completed",
      projectedThroughSeq: 0,
      durationMs: 1,
    });
    expect(next.seq).toBe(2);
    expect((await store.loadAndRepair("c1")).map((record) => record.seq)).toEqual([
      1, 2,
    ]);
  });
});
