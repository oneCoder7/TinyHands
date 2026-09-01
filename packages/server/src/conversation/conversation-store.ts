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
import type {
  ConversationMetadata,
  LegacyConversationMetadata,
  StoredConversationMetadata,
} from "./conversation-metadata.js";

const EVENTS_FILE = "events.jsonl";
const META_FILE = "meta.json";

const LegacyConversationMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversationId: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    tools: z.array(z.string()).optional(),
  })
  .strict();

const ConversationMetadataSchema = z
  .object({
    schemaVersion: z.literal(2),
    conversationId: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
    config: z
      .object({
        tools: z.array(z.string()),
        maxSteps: z.number().int().positive(),
        maxModelAttemptsPerStep: z.number().int().positive(),
        autoCompact: z
          .object({
            enabled: z.boolean(),
            contextWindow: z.number().int().positive(),
            triggerRatio: z.number().positive().max(1),
            targetRatio: z.number().positive().max(1),
            maxOutputTokens: z.number().int().positive(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

const LegacyMetaSchema = z
  .object({
    createdAt: z.number().int().nonnegative(),
    tools: z.array(z.string()).optional(),
  })
  .strict();

export class ConversationMetadataExistsError extends Error {
  constructor(conversationId: string) {
    super(`conversation metadata 已存在：${conversationId}`);
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

/** Conversation 的 metadata、事件与存在性由同一套 Store 负责。 */
export interface ConversationStore extends EventAppender {
  /** 排他创建 metadata；已存在必须失败。 */
  create(metadata: ConversationMetadata): Promise<void>;
  /** 原子替换 metadata；仅用于受控 schema 迁移。 */
  replaceMetadata(metadata: ConversationMetadata): Promise<void>;
  exists(conversationId: string): Promise<boolean>;
  list(): Promise<StoredConversationMetadata[]>;
  load(
    conversationId: string
  ): Promise<{ metadata: StoredConversationMetadata; events: Event[] } | undefined>;
  /** 删除整个 Conversation 目录，包含事件、run log 与 Local workspace。 */
  delete(conversationId: string): Promise<void>;
}

/**
 * 文件系统 ConversationStore。
 *
 * meta.json 是 Conversation 的存在性记录；events.jsonl 是 append-only 事件流。
 * 兼容旧数据：旧 meta 会原地升级为 schemaVersion=1；只有 events 的会话会依据首条
 * event 生成 legacy metadata。v1 → v2 的 effective config 迁移由 Service 完成。
 * meta 存在但损坏时明确失败，禁止静默换成默认 tools。
 */
export class FsConversationStore implements ConversationStore {
  private readonly log: TinyhandsLogger;

  constructor(
    private readonly workspaceRoot: string,
    logger: TinyhandsLogger = noopLogger
  ) {
    this.log = logger.child({ module: "conversation-store" });
  }

  async create(metadata: ConversationMetadata): Promise<void> {
    const validated = ConversationMetadataSchema.parse(metadata);
    const dir = this.dirOf(validated.conversationId);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(this.metaOf(validated.conversationId), JSON.stringify(validated), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ConversationMetadataExistsError(validated.conversationId);
      }
      throw err;
    }
  }

  async exists(conversationId: string): Promise<boolean> {
    if (await this.readMetadata(conversationId)) return true;
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
  ): Promise<{ metadata: StoredConversationMetadata; events: Event[] } | undefined> {
    const metadata = await this.readMetadata(conversationId);
    const events = await this.loadEvents(conversationId);
    if (metadata) return { metadata, events };
    if (events.length === 0) return undefined;

    // 兼容最早期只有 events.jsonl 的数据；tools 缺省沿用旧版 run_bash 默认值。
    const migrated: LegacyConversationMetadata = {
      schemaVersion: 1,
      conversationId,
      createdAt: events[0]?.timestamp ?? 0,
    };
    try {
      await this.createLegacyMetadata(migrated);
      return { metadata: migrated, events };
    } catch (err) {
      if (!(err instanceof ConversationMetadataExistsError)) throw err;
      const raced = await this.readMetadata(conversationId);
      if (!raced) {
        throw new ConversationRecoveryError(
          conversationId,
          "metadata 迁移竞争后仍不可读取"
        );
      }
      return { metadata: raced, events };
    }
  }

  async list(): Promise<StoredConversationMetadata[]> {
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
          const metadata = await this.readMetadata(entry.name);
          if (metadata) return metadata;
          return (await this.load(entry.name))?.metadata;
        })
    );
    return loaded
      .filter(
        (metadata): metadata is StoredConversationMetadata => metadata !== undefined
      );
  }

  async replaceMetadata(metadata: ConversationMetadata): Promise<void> {
    const validated = ConversationMetadataSchema.parse(metadata);
    await this.replaceMetadataFile(validated);
  }

  async delete(conversationId: string): Promise<void> {
    await rm(this.dirOf(conversationId), { recursive: true, force: true });
  }

  private async readMetadata(
    conversationId: string
  ): Promise<StoredConversationMetadata | undefined> {
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

    const current = ConversationMetadataSchema.safeParse(json);
    if (current.success) {
      if (current.data.conversationId !== conversationId) {
        throw new ConversationRecoveryError(
          conversationId,
          `metadata identity 不匹配：${current.data.conversationId}`
        );
      }
      return current.data;
    }

    const v1 = LegacyConversationMetadataSchema.safeParse(json);
    if (v1.success) {
      if (v1.data.conversationId !== conversationId) {
        throw new ConversationRecoveryError(
          conversationId,
          `metadata identity 不匹配：${v1.data.conversationId}`
        );
      }
      return v1.data;
    }

    const legacy = LegacyMetaSchema.safeParse(json);
    if (!legacy.success) {
      throw new ConversationRecoveryError(conversationId, "meta.json 字段不合法");
    }
    const migrated: LegacyConversationMetadata = {
      schemaVersion: 1,
      conversationId,
      createdAt: legacy.data.createdAt,
      ...(legacy.data.tools ? { tools: legacy.data.tools } : {}),
    };
    await this.replaceLegacyMetadata(migrated);
    return migrated;
  }

  private async createLegacyMetadata(
    metadata: LegacyConversationMetadata
  ): Promise<void> {
    const validated = LegacyConversationMetadataSchema.parse(metadata);
    const dir = this.dirOf(validated.conversationId);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(this.metaOf(validated.conversationId), JSON.stringify(validated), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ConversationMetadataExistsError(validated.conversationId);
      }
      throw err;
    }
  }

  private replaceLegacyMetadata(
    metadata: LegacyConversationMetadata
  ): Promise<void> {
    return this.replaceMetadataFile(
      LegacyConversationMetadataSchema.parse(metadata)
    );
  }

  private async replaceMetadataFile(
    metadata: StoredConversationMetadata
  ): Promise<void> {
    const target = this.metaOf(metadata.conversationId);
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, JSON.stringify(metadata), "utf8");
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
