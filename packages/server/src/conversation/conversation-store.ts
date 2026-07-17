import {
  appendFile,
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  noopLogger,
  type TinyhandsLogger,
} from "../logging/logger.js";
import type { Event } from "./events.js";

const EVENTS_FILE = "events.jsonl";
const META_FILE = "meta.json";

export interface ConversationRecord {
  schemaVersion: 1;
  conversationId: string;
  createdAt: number;
  tools?: string[];
}

const ConversationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    tools: z.array(z.string()).optional(),
  })
  .strict();

const LegacyMetaSchema = z
  .object({
    createdAt: z.number().int().nonnegative(),
    tools: z.array(z.string()).optional(),
  })
  .strict();

export class ConversationRecordExistsError extends Error {
  constructor(conversationId: string) {
    super(`conversation record 已存在：${conversationId}`);
  }
}

export class ConversationRecoveryError extends Error {
  constructor(conversationId: string, reason: string) {
    super(`conversation ${conversationId} 恢复失败：${reason}`);
  }
}

/** EventStream 只依赖追加端口，不取得 Store 的生命周期能力。 */
export interface EventAppender {
  appendEvent(conversationId: string, event: Event): Promise<void>;
}

/** Conversation 的记录、事件与存在性由同一套 Store 负责。 */
export interface ConversationStore extends EventAppender {
  /** 排他创建 metadata；已存在必须失败。 */
  create(record: ConversationRecord): Promise<void>;
  exists(conversationId: string): Promise<boolean>;
  list(): Promise<ConversationRecord[]>;
  load(
    conversationId: string
  ): Promise<{ record: ConversationRecord; events: Event[] } | undefined>;
  /** 删除整个 Conversation 目录，包含事件、run log 与 Local workspace。 */
  delete(conversationId: string): Promise<void>;
}

/**
 * 文件系统 ConversationStore。
 *
 * meta.json 是 Conversation 的存在性记录；events.jsonl 是 append-only 事件流。
 * 兼容旧数据：旧 meta 会原地升级为 schemaVersion=1；只有 events 的会话会依据首条
 * event 生成 record。meta 存在但损坏时明确失败，禁止静默换成默认 tools。
 */
export class FsConversationStore implements ConversationStore {
  private readonly log: TinyhandsLogger;

  constructor(
    private readonly workspaceRoot: string,
    logger: TinyhandsLogger = noopLogger
  ) {
    this.log = logger.child({ module: "conversation-store" });
  }

  async create(record: ConversationRecord): Promise<void> {
    const validated = ConversationRecordSchema.parse(record);
    const dir = this.dirOf(validated.conversationId);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(this.metaOf(validated.conversationId), JSON.stringify(validated), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ConversationRecordExistsError(validated.conversationId);
      }
      throw err;
    }
  }

  async exists(conversationId: string): Promise<boolean> {
    if (await this.readRecord(conversationId)) return true;
    try {
      await access(this.eventsOf(conversationId));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async appendEvent(conversationId: string, event: Event): Promise<void> {
    await mkdir(this.dirOf(conversationId), { recursive: true });
    await appendFile(this.eventsOf(conversationId), JSON.stringify(event) + "\n", "utf8");
  }

  async load(
    conversationId: string
  ): Promise<{ record: ConversationRecord; events: Event[] } | undefined> {
    const record = await this.readRecord(conversationId);
    const events = await this.loadEvents(conversationId);
    if (record) return { record, events };
    if (events.length === 0) return undefined;

    // 兼容最早期只有 events.jsonl 的数据；tools 缺省沿用旧版 run_bash 默认值。
    const migrated: ConversationRecord = {
      schemaVersion: 1,
      conversationId,
      createdAt: events[0]?.timestamp ?? 0,
    };
    try {
      await this.create(migrated);
      return { record: migrated, events };
    } catch (err) {
      if (!(err instanceof ConversationRecordExistsError)) throw err;
      const raced = await this.readRecord(conversationId);
      if (!raced) {
        throw new ConversationRecoveryError(
          conversationId,
          "metadata 迁移竞争后仍不可读取"
        );
      }
      return { record: raced, events };
    }
  }

  async list(): Promise<ConversationRecord[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.workspaceRoot, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const loaded = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const record = await this.readRecord(entry.name);
          if (record) return record;
          return (await this.load(entry.name))?.record;
        })
    );
    return loaded
      .filter(
        (record): record is ConversationRecord => record !== undefined
      );
  }

  async delete(conversationId: string): Promise<void> {
    await rm(this.dirOf(conversationId), { recursive: true, force: true });
  }

  private async readRecord(
    conversationId: string
  ): Promise<ConversationRecord | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.metaOf(conversationId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ConversationRecoveryError(conversationId, "meta.json 不是合法 JSON");
    }

    const current = ConversationRecordSchema.safeParse(json);
    if (current.success) {
      if (current.data.conversationId !== conversationId) {
        throw new ConversationRecoveryError(
          conversationId,
          `metadata identity 不匹配：${current.data.conversationId}`
        );
      }
      return current.data;
    }

    const legacy = LegacyMetaSchema.safeParse(json);
    if (!legacy.success) {
      throw new ConversationRecoveryError(conversationId, "meta.json 字段不合法");
    }
    const migrated: ConversationRecord = {
      schemaVersion: 1,
      conversationId,
      createdAt: legacy.data.createdAt,
      ...(legacy.data.tools ? { tools: legacy.data.tools } : {}),
    };
    await this.replaceRecord(migrated);
    return migrated;
  }

  private async replaceRecord(record: ConversationRecord): Promise<void> {
    const target = this.metaOf(record.conversationId);
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    try {
      await rename(temporary, target);
    } catch (err) {
      await rm(temporary, { force: true });
      throw err;
    }
  }

  private async loadEvents(conversationId: string): Promise<Event[]> {
    let raw: string;
    try {
      raw = await readFile(this.eventsOf(conversationId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const events: Event[] = [];
    let previousSeq: number | null = null;
    for (const [index, line] of raw.split("\n").entries()) {
      if (line.trim() === "") continue;
      let parsed: Event;
      try {
        parsed = JSON.parse(line) as Event;
      } catch {
        this.log.warn(
          { conversationId, line: index + 1, kept: events.length },
          "事件行解析失败,截断坏尾"
        );
        break;
      }
      if (
        typeof parsed.seq !== "number" ||
        (previousSeq !== null && parsed.seq !== previousSeq + 1)
      ) {
        this.log.warn(
          {
            conversationId,
            line: index + 1,
            expected: previousSeq === null ? undefined : previousSeq + 1,
            got: parsed.seq,
          },
          "seq 缺口,截断坏尾"
        );
        break;
      }
      events.push(parsed);
      previousSeq = parsed.seq;
    }
    return events;
  }

  private dirOf(conversationId: string): string {
    return join(this.workspaceRoot, conversationId);
  }

  private eventsOf(conversationId: string): string {
    return join(this.dirOf(conversationId), EVENTS_FILE);
  }

  private metaOf(conversationId: string): string {
    return join(this.dirOf(conversationId), META_FILE);
  }
}
