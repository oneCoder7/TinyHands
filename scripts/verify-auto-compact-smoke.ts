#!/usr/bin/env node
/**
 * 真实 Auto-Compact smoke：默认配置下触发真实摘要调用，并验证中断、重试、
 * checkpoint、Public View、Run Log 和从磁盘恢复后的上下文投影。
 *
 * 使用临时 workspace，不输出摘要、prompt、凭据或对话正文。
 */
import "dotenv/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculateCompactionBudget,
  ContextCompactor,
  estimateCanonicalInputTokens,
} from "../packages/server/src/agent/context-compactor.js";
import { Conversation } from "../packages/server/src/conversation/conversation.js";
import { FsConversationStore } from "../packages/server/src/conversation/conversation-store.js";
import {
  projectCompactedContext,
  projectToMessages,
  type StreamItem,
} from "../packages/server/src/conversation/events.js";
import { readStandaloneConfig } from "../apps/standalone/src/config.js";
import { createLLMClient } from "../packages/server/src/llm/factory.js";
import { RunJournal } from "../packages/server/src/observability/run-log.js";
import { FsRunLogStore } from "../packages/server/src/observability/run-log-store.js";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function historyBlock(index: number, role: "user" | "assistant"): string {
  const seed =
    `segment=${index};role=${role};objective=verify-auto-compact;` +
    `decision=keep-event-source;constraint=no-data-loss;` +
    `completed=provider-smoke;current=compact-validation;next=continue;`;
  return seed.repeat(28);
}

async function seedHistory(conversation: Conversation): Promise<void> {
  for (let index = 0; index < 4; index++) {
    await conversation.emit({
      type: "user_message",
      source: "user",
      text: historyBlock(index, "user"),
    });
    await conversation.emit({
      type: "agent_message",
      source: "agent",
      text: historyBlock(index, "assistant"),
      toolCalls: [],
    });
  }
  await conversation.emit({
    type: "user_message",
    source: "user",
    text: "protected-query-before-interrupt",
  });
}

async function main(): Promise<void> {
  const config = readStandaloneConfig(process.env).host;
  invariant(config.llm.autoCompact.enabled, "Auto-Compact 当前被关闭");
  const budget = calculateCompactionBudget(
    config.llm.autoCompact,
    config.llm.maxTokens
  );
  const tmpHome = mkdtempSync(join(tmpdir(), "tinyhands-compact-smoke-"));
  const workspaceRoot = join(tmpHome, "workspace");
  const conversationId = "compact-smoke";
  let passed = false;

  try {
    const conversationStore = new FsConversationStore(workspaceRoot);
    const runLogStore = new FsRunLogStore(workspaceRoot);
    const journal = await RunJournal.open(conversationId, runLogStore);
    const llm = createLLMClient(config.llm);
    const conversation = new Conversation(conversationId, {
      store: conversationStore,
    });
    await seedHistory(conversation);

    const before = conversation.getEvents();
    const estimatedBefore = estimateCanonicalInputTokens(
      projectToMessages(before),
      [],
      []
    );
    invariant(
      estimatedBefore >= budget.triggerTokens,
      `构造历史未达到触发阈值：${estimatedBefore} < ${budget.triggerTokens}`
    );
    console.log(
      `Auto-Compact smoke: ${llm.identity.provider}/${llm.identity.model} ` +
        `(${llm.identity.apiMode}), estimate=${estimatedBefore}, trigger=${budget.triggerTokens}`
    );

    const compactor = new ContextCompactor(
      llm,
      journal,
      config.llm.autoCompact,
      config.llm.maxTokens
    );

    // 第一次在真实摘要请求期间中断。
    const controller = new AbortController();
    let abortTimer: NodeJS.Timeout | undefined;
    const interruptOnStart = (item: StreamItem) => {
      if (!("type" in item) || item.type !== "compaction_started") return;
      abortTimer = setTimeout(() => controller.abort(), 200);
    };
    conversation.subscribe(interruptOnStart);
    let interrupted = false;
    try {
      await compactor.prepare(conversation, before, [], {
        runId: "compact-run-interrupted",
        step: 0,
        signal: controller.signal,
      });
    } catch {
      interrupted = controller.signal.aborted;
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
      conversation.unsubscribe(interruptOnStart);
    }
    invariant(interrupted, "真实摘要请求没有被 AbortSignal 中断");
    const afterInterrupt = conversation.getEvents();
    invariant(
      afterInterrupt.some((event) => event.type === "compaction_cancelled"),
      "中断后缺少 compaction_cancelled"
    );
    invariant(
      !afterInterrupt.some((event) => event.type === "compacted"),
      "中断后不应提交 checkpoint"
    );
    invariant(
      journal
        .getRecords()
        .some(
          (record) =>
            record.type === "llm_failed" &&
            record.purpose === "compaction" &&
            record.outcome === "aborted"
        ),
      "Run Log 缺少 compaction llm_failed(aborted)"
    );
    console.log("✓ 真实摘要请求 interrupt → cancelled，未提交 checkpoint");

    // interrupt 后的新 query 重新触发，且必须留在原始 tail。
    const retryQuery = "protected-query-after-interrupt";
    await conversation.emit({
      type: "user_message",
      source: "user",
      text: retryQuery,
    });
    const retryEvents = conversation.getEvents();
    const prepared = await compactor.prepare(conversation, retryEvents, [], {
      runId: "compact-run-retry",
      step: 0,
    });
    invariant(prepared.compacted, "新 query 到达后没有重新触发压缩");
    invariant(prepared.systemContext.length === 1, "压缩摘要没有进入 systemContext");
    invariant(
      prepared.messages.some(
        (message) => message.role === "user" && message.text === retryQuery
      ),
      "interrupt 后的新 query 没有保留在原始 tail"
    );

    const committedEvents = conversation.getEvents();
    const started = committedEvents.filter(
      (event) => event.type === "compaction_started"
    );
    invariant(started.length === 2, "应当存在两次独立 compaction_started");
    invariant(
      new Set(started.map((event) => event.compactionId)).size === 2,
      "重试必须生成新的 compactionId"
    );
    invariant(
      committedEvents.some((event) => event.type === "compacted"),
      "重试后缺少内部 checkpoint"
    );
    invariant(
      committedEvents.some((event) => event.type === "compaction_completed"),
      "重试后缺少 compaction_completed"
    );
    invariant(
      journal
        .getRecords()
        .some(
          (record) =>
            record.type === "llm_disposition" &&
            record.outcome === "committed" &&
            record.compactionId !== undefined
        ),
      "Run Log 缺少已提交的 compaction disposition"
    );
    console.log("✓ 新 query 重新压缩 → checkpoint + completed");

    // 磁盘恢复后继续应用 checkpoint，Public View 仍隐藏内部摘要。
    const loaded = (await conversationStore.load(conversationId))?.events ?? [];
    const resumed = new Conversation(conversationId, {
      store: conversationStore,
      initialEvents: loaded,
    });
    const projected = projectCompactedContext(resumed.getEvents());
    invariant(projected.checkpoint !== undefined, "恢复后没有应用最新 checkpoint");
    invariant(projected.systemContext.length === 1, "恢复后缺少摘要 systemContext");
    invariant(
      projected.messages.some(
        (message) => message.role === "user" && message.text === retryQuery
      ),
      "恢复投影丢失最新 query"
    );
    invariant(
      resumed.getPublicEvents().every((event) => String(event.type) !== "compacted"),
      "Public View 泄露了内部 checkpoint"
    );
    invariant(
      resumed
        .getPublicEvents()
        .some((event) => event.type === "compaction_completed"),
      "Public View 缺少 compaction_completed"
    );
    console.log("✓ 磁盘恢复投影 + Public View");

    passed = true;
    console.log("✓ PASS —— Auto-Compact 真实 endpoint smoke 全部通过");
  } finally {
    if (passed) {
      rmSync(tmpHome, { recursive: true, force: true });
    } else {
      console.log(`保留失败现场：${tmpHome}`);
    }
  }
}

main().catch((error) => {
  console.error(`✗ Auto-Compact smoke 失败：${(error as Error).message}`);
  process.exit(1);
});
