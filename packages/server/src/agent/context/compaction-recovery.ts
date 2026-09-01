import type { Conversation } from "../../conversation/conversation.js";
import type { CompactSummary, Event } from "../../conversation/events.js";

type Checkpoint =
  | Extract<Event, { type: "compacted" }>
  | (Extract<Event, { type: "compaction_completed" }> & {
      replacesCompactionSeq?: number;
      summaryVersion: 1;
      summary: CompactSummary;
      provider: string;
      model: string;
    });

/** 只根据 Conversation Event 修复未闭合压缩事务。 */
export class CompactionRecovery {
  constructor(private readonly conversation: Conversation) {}

  async recover(): Promise<void> {
    const states = new Map<
      string,
      { started: boolean; terminal: boolean; checkpoint?: Checkpoint }
    >();
    for (const event of this.conversation.getEvents()) {
      if (
        event.type !== "compaction_started" &&
        event.type !== "compaction_completed" &&
        event.type !== "compaction_cancelled" &&
        event.type !== "compaction_failed" &&
        event.type !== "compacted"
      ) {
        continue;
      }
      const state = states.get(event.compactionId) ?? {
        started: false,
        terminal: false,
      };
      if (event.type === "compaction_started") state.started = true;
      if (
        event.type === "compacted" ||
        (event.type === "compaction_completed" && "summary" in event)
      ) {
        state.checkpoint = event;
      }
      if (
        event.type === "compaction_completed" ||
        event.type === "compaction_cancelled" ||
        event.type === "compaction_failed"
      ) {
        state.terminal = true;
      }
      states.set(event.compactionId, state);
    }

    for (const [compactionId, state] of states) {
      if (!state.started || state.terminal) continue;
      if (!state.checkpoint) {
        await this.conversation.emit({
          type: "compaction_cancelled",
          source: "agent",
          compactionId,
          reason: "process_restarted",
        });
        continue;
      }
      const checkpoint = state.checkpoint;
      await this.conversation.emit({
        type: "compaction_completed",
        source: "agent",
        compactionId,
        throughSeq: checkpoint.throughSeq,
        ...(checkpoint.replacesCompactionSeq !== undefined
          ? { replacesCompactionSeq: checkpoint.replacesCompactionSeq }
          : {}),
        summaryVersion: checkpoint.summaryVersion,
        summary: checkpoint.summary,
        provider: checkpoint.provider,
        model: checkpoint.model,
        estimatedBeforeTokens: checkpoint.estimatedBeforeTokens,
        estimatedAfterTokens: checkpoint.estimatedAfterTokens,
      });
    }
  }
}
