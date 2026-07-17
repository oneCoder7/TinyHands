import { appendFile, mkdir, readFile, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import {
  noopLogger,
  type TinyhandsLogger,
} from "../logging/logger.js";
import { RunLogRecordSchema, type RunLogRecord } from "./run-log.js";

const RUN_LOG_FILE = "run_log.jsonl";

export interface RunLogStore {
  loadAndRepair(conversationId: string): Promise<RunLogRecord[]>;
  append(conversationId: string, record: RunLogRecord): Promise<void>;
  remove(conversationId: string): Promise<void>;
}

/** 每会话一个 append-only JSONL 文件；加载时物理截断首个坏行及其后内容。 */
export class FsRunLogStore implements RunLogStore {
  private readonly log: TinyhandsLogger;

  constructor(
    private readonly workspaceRoot: string,
    logger: TinyhandsLogger = noopLogger
  ) {
    this.log = logger.child({ module: "run-log-store" });
  }

  private fileOf(conversationId: string): string {
    return join(this.workspaceRoot, conversationId, RUN_LOG_FILE);
  }

  async append(conversationId: string, record: RunLogRecord): Promise<void> {
    const validated = RunLogRecordSchema.parse(record);
    const dir = join(this.workspaceRoot, conversationId);
    await mkdir(dir, { recursive: true });
    await appendFile(
      this.fileOf(conversationId),
      JSON.stringify(validated) + "\n",
      "utf8"
    );
  }

  async loadAndRepair(conversationId: string): Promise<RunLogRecord[]> {
    const file = this.fileOf(conversationId);
    let raw: Buffer;
    try {
      raw = await readFile(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const records: RunLogRecord[] = [];
    let cursor = 0;
    let validEnd = 0;
    let repairReason: string | undefined;

    while (cursor < raw.length) {
      const newline = raw.indexOf(0x0a, cursor);
      if (newline === -1) {
        repairReason = "incomplete_tail";
        break;
      }
      let lineEnd = newline;
      if (lineEnd > cursor && raw[lineEnd - 1] === 0x0d) lineEnd--;
      const line = raw.subarray(cursor, lineEnd).toString("utf8");
      if (line.length === 0) {
        repairReason = "empty_line";
        break;
      }

      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        repairReason = "invalid_json";
        break;
      }
      const parsed = RunLogRecordSchema.safeParse(json);
      if (!parsed.success) {
        repairReason = "invalid_record";
        break;
      }
      if (
        parsed.data.conversationId !== conversationId ||
        parsed.data.seq !== records.length + 1
      ) {
        repairReason = "identity_or_seq_gap";
        break;
      }

      records.push(parsed.data);
      validEnd = newline + 1;
      cursor = newline + 1;
    }

    if (repairReason) {
      await truncate(file, validEnd);
      this.log.warn(
        { conversationId, repairReason, kept: records.length, truncatedBytes: raw.length - validEnd },
        "Run Log 坏尾已物理截断"
      );
    }
    return records;
  }

  async remove(conversationId: string): Promise<void> {
    await rm(this.fileOf(conversationId), { force: true });
  }
}
