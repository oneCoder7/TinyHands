import type { Conversation } from "../conversation/conversation.js";
import {
  findHumanInteractionResolution,
  findPendingHumanInteraction,
  findUnmatchedToolCalls,
  type Event,
  type HumanInteractionRequested,
} from "../conversation/events.js";
import type { TinyhandsLogger } from "../logging/logger.js";
import { noopLogger } from "../logging/logger.js";
import type { RunJournal } from "../observability/run-log.js";
import { CompactionRecovery } from "./context/compaction-recovery.js";
import type { ToolCallHandler } from "./step/tool-call/tool-call-handler.js";

export type AgentRecoveryContinuation =
  | { type: "interaction"; request: HumanInteractionRequested }
  | {
      type: "agent_message";
      agentMessage: Extract<Event, { type: "agent_message" }>;
    };

/** Agent 内部恢复 facade；业务恢复判断只读取 Conversation Event。 */
export class AgentRecovery {
  private readonly log: TinyhandsLogger;

  constructor(
    private readonly conversation: Conversation,
    private readonly journal: RunJournal,
    private readonly toolCalls: ToolCallHandler,
    private readonly compactions: CompactionRecovery,
    logger: TinyhandsLogger = noopLogger
  ) {
    this.log = logger.child({ module: "agent-recovery" });
  }

  async recover(): Promise<AgentRecoveryContinuation | undefined> {
    await this.compactions.recover();
    const events = this.conversation.getEvents();
    const pending = findPendingHumanInteraction(events);
    const protectedRunIds = new Set<string>();
    if (pending) protectedRunIds.add(pending.continuation.runId);

    const orphans = findUnmatchedToolCalls(events);
    const dispatched = new Set(
      events
        .filter((event) => event.type === "tool_call_dispatched")
        .map((event) => event.toolCallId)
    );
    const agentMessages = events.filter(
      (event): event is Extract<Event, { type: "agent_message" }> =>
        event.type === "agent_message"
    );
    const unsafeCallIds = new Set(
      agentMessages.flatMap((message) => {
        const callIds = message.toolCalls.map((call) => call.id);
        return !message.executionTrace || callIds.some((id) => dispatched.has(id))
          ? callIds
          : [];
      })
    );

    for (const message of agentMessages) {
      const unsafe = message.toolCalls.filter(
        (call) =>
          orphans.some((orphan) => orphan.id === call.id) &&
          unsafeCallIds.has(call.id)
      );
      if (unsafe.length === 0) continue;
      this.log.warn(
        { conversationId: this.conversation.id, count: unsafe.length },
        "恢复发现已派发但结果未知的 tool_call，补偿 error tool_result"
      );
      if (message.executionTrace) {
        await this.toolCalls.closePendingCalls(
          unsafe,
          message.executionTrace,
          "process_restarted",
          "进程中断,该工具未完成执行"
        );
      } else {
        for (const call of unsafe) {
          await this.conversation.emit({
            type: "tool_result",
            source: "environment",
            toolCallId: call.id,
            content: "进程中断,该工具未完成执行",
            isError: true,
          });
        }
      }
    }

    const repairedEvents = this.conversation.getEvents();
    const remaining = findUnmatchedToolCalls(repairedEvents);
    const resumableRequest = [...repairedEvents].reverse().find(
      (event): event is HumanInteractionRequested =>
        event.type === "human_interaction_requested" &&
        !!findHumanInteractionResolution(repairedEvents, event.interactionId) &&
        remaining.some((call) => call.id === event.request.target.toolCallId) &&
        !dispatched.has(event.request.target.toolCallId)
    );
    if (resumableRequest) protectedRunIds.add(resumableRequest.continuation.runId);

    const resumableAgentMessage = [...agentMessages].reverse().find(
      (event) =>
        !!event.executionTrace &&
        event.toolCalls.some((call) => remaining.some((item) => item.id === call.id)) &&
        event.toolCalls.every((call) => !unsafeCallIds.has(call.id)) &&
        !resumableRequest
    );
    if (resumableAgentMessage?.executionTrace) {
      protectedRunIds.add(resumableAgentMessage.executionTrace.runId);
    }

    // Run Log 只修复审计终态；protected IDs 也来自 Conversation 恢复判断。
    await this.journal.recoverOpenRuns(protectedRunIds);
    if (resumableRequest) return { type: "interaction", request: resumableRequest };
    if (resumableAgentMessage) {
      return { type: "agent_message", agentMessage: resumableAgentMessage };
    }
    return undefined;
  }
}
