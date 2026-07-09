/**
 * 事件持久化 —— 把「唯一真相源」从内存落到磁盘。
 *
 * EventStream 是内存里的真相源;EventStore 是它的磁盘镜像。二者关系:
 *  - emit 定稿一个事件 → EventStream 先 await store.append 落盘、成功后再 push 内存 + 广播
 *    (先落盘后广播:订阅者/投影看到的一定是已持久化的事件)
 *  - 进程重启 → store.load 读回事件 → 灌进新 EventStream,会话恢复
 *
 * 抽象成接口是为了可插拔:默认 FsEventStore 落本地文件,将来换 S3/DB 不改上层。
 */

import { appendFile, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "./events.js";
import { logger } from "../core/logger.js";

const log = logger.child({ module: "event-store" });

/**
 * 会话元信息 —— 恢复时需要的「非事件」状态。与事件流分开存:它小、改动少(只在
 * create 时写一次),不需要 append/坏尾扫描那套机制。单文件 JSON 一次性覆盖写。
 */
export interface ConversationMeta {
  /** 创建时间戳(毫秒) */
  createdAt: number;
  /** 可选工具列表(create 时传入,恢复时重新注册到 ToolRegistry) */
  tools?: string[];
}

/**
 * 事件存储端口。实现者负责「一会话一份、只追加」的持久化语义。
 * 全进程一个实例(单例),按 conversationId 分文件。
 *
 * 事件流用 append/load(append-only + 坏尾扫描);元信息用 saveMeta/loadMeta(单文件
 * 覆盖写)。两者分文件:events.jsonl 追加,meta.json 覆盖。
 */
export interface EventStore {
  /**
   * 追加一条已定稿事件(含 id/seq/timestamp)。Promise resolve 即落盘完成。
   * 落盘失败必须 reject —— 上层据此中断本轮 run,绝不制造内存/磁盘分叉。
   */
  append(conversationId: string, event: Event): Promise<void>;

  /**
   * 读回某会话的全部事件,已按 seq 升序、已剔除坏尾(崩溃残留的半条/缺口之后)。
   * 会话不存在返回 []。
   */
  load(conversationId: string): Promise<Event[]>;

  /** 写元信息(覆盖)。create 时调用一次。 */
  saveMeta(conversationId: string, meta: ConversationMeta): Promise<void>;

  /** 读元信息。不存在返回 undefined。 */
  loadMeta(conversationId: string): Promise<ConversationMeta | undefined>;

  /** 列出所有已持久化的会话 id(重启后 list / 懒加载定位用)。 */
  list(): Promise<string[]>;

  /** 删除某会话的事件文件(destroy 时用)。幂等:不存在不报错。 */
  remove(conversationId: string): Promise<void>;
}

/** 事件文件名(每会话一份,位于 <root>/<id>/ 下)。 */
const EVENTS_FILE = "events.jsonl";
/** 元信息文件名(create 时写一次,恢复时读)。 */
const META_FILE = "meta.json";

/**
 * 本地文件系统实现 —— 事件落 <workspaceRoot>/<id>/events.jsonl,与该会话的
 * workspace 同目录。选此布局:destroy 删整个 <id>/ 目录即连事件一起清,语义最干净。
 *
 * 崩溃一致性不靠原子写/WAL,靠三件事的组合(实证蓝本:OpenHands agent-sdk):
 *  ① 事件不可变、只追加,一事件一行 JSON;
 *  ② seq 单调连续(EventStream 生成);
 *  ③ load 扫描时校验连续性,遇解析失败或 seq 缺口即截断,丢弃坏尾(该行及之后)。
 * 半条尾行(崩溃写一半)会解析失败 → 被丢弃,不影响前面已完整落盘的事件。
 *
 * 所有 I/O 走 fs/promises(异步纪律:绝不在事件循环上做同步阻塞 I/O)。
 */
export class FsEventStore implements EventStore {
  constructor(private readonly workspaceRoot: string) {}

  private fileOf(conversationId: string): string {
    return join(this.workspaceRoot, conversationId, EVENTS_FILE);
  }

  async append(conversationId: string, event: Event): Promise<void> {
    const dir = join(this.workspaceRoot, conversationId);
    // 目录一般已由 ConversationManager.create 建好;这里兜底保证 EventStore 自洽
    // (测试直接用、或恢复路径下目录被清理过)。recursive 幂等。
    await mkdir(dir, { recursive: true });
    // 一事件一行:JSON.stringify 保证单行(无内嵌裸换行),行尾补 \n。
    await appendFile(this.fileOf(conversationId), JSON.stringify(event) + "\n", "utf8");
  }

  async load(conversationId: string): Promise<Event[]> {
    let raw: string;
    try {
      raw = await readFile(this.fileOf(conversationId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // 会话不存在
      throw err;
    }

    const events: Event[] = [];
    let prevSeq: number | null = null;
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.trim() === "") continue; // 末尾追加产生的空行,跳过(非坏尾)

      let parsed: Event;
      try {
        parsed = JSON.parse(line) as Event;
      } catch {
        // 解析失败 = 崩溃写到一半的坏尾。截断:丢弃本行及之后,返回干净前缀。
        log.warn(
          { conversationId, line: i + 1, kept: events.length },
          "事件行解析失败,截断坏尾"
        );
        break;
      }

      // seq 连续性校验:第一条设基准,之后必须严格 = 上一条 +1。遇缺口即停,
      // 丢弃当前及之后(缺口意味着中间有事件没落盘成功,后续不可信)。
      if (typeof parsed.seq !== "number") {
        log.warn({ conversationId, line: i + 1 }, "事件缺 seq,截断");
        break;
      }
      if (prevSeq !== null && parsed.seq !== prevSeq + 1) {
        log.warn(
          { conversationId, line: i + 1, expected: prevSeq + 1, got: parsed.seq },
          "seq 缺口,截断坏尾"
        );
        break;
      }
      events.push(parsed);
      prevSeq = parsed.seq;
    }
    return events;
  }

  async saveMeta(conversationId: string, meta: ConversationMeta): Promise<void> {
    const dir = join(this.workspaceRoot, conversationId);
    await mkdir(dir, { recursive: true });
    // 覆盖写:meta 只在 create 时写一次,不存在并发。单文件整体 JSON。
    await writeFile(
      join(dir, META_FILE),
      JSON.stringify(meta),
      "utf8"
    );
  }

  async loadMeta(conversationId: string): Promise<ConversationMeta | undefined> {
    try {
      const raw = await readFile(
        join(this.workspaceRoot, conversationId, META_FILE),
        "utf8"
      );
      return JSON.parse(raw) as ConversationMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // 坏 JSON(文件存在但损坏):返回 undefined 退化,不阻断恢复
      if (err instanceof SyntaxError) {
        log.warn({ conversationId }, "meta.json 解析失败,退化用默认值");
        return undefined;
      }
      throw err;
    }
  }

  async list(): Promise<string[]> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(this.workspaceRoot, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // 根目录还没建
      throw err;
    }
    // 只认「含 events.jsonl 的子目录」为持久化会话。并发探测各子目录。
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const checks = await Promise.all(
      dirs.map(async (name) => {
        try {
          await readFile(join(this.workspaceRoot, name, EVENTS_FILE), "utf8");
          return name;
        } catch {
          return null; // 无事件文件(只有 workspace 没跑过)→ 不算持久化会话
        }
      })
    );
    return checks.filter((n): n is string => n !== null);
  }

  async remove(conversationId: string): Promise<void> {
    // 只删事件文件(force 幂等)。注意:ConversationManager.destroy 会 rm 整个 <id>/
    // 目录(连 workspace 带 events 一起清),故正常销毁路径其实无需单独调本方法;
    // 保留它是为 EventStore 接口自洽 + 将来 events 与 workspace 分离时可用。
    await rm(this.fileOf(conversationId), { force: true });
  }
}
