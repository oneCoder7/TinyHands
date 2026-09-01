import type { Conversation } from "../conversation/conversation.js";
import {
  findHumanInteractionResolution,
  projectToolPolicyMode,
} from "../conversation/events.js";
import type { ToolCall, ToolResult } from "../llm/types.js";
import type { RunJournal } from "../observability/run-log.js";
import type { HumanInteractionCoordinator } from "../server/human-interaction.js";
import type { ToolContext, ToolRegistry } from "../tools/tool.js";
import {
  evaluateToolPolicy,
  type ToolPolicyGetter,
} from "../tools/tool-policy.js";

export interface ToolTrace {
  runId: string;
  step: number;
  llmCallId: string;
  projectedThroughSeq: number;
}

export type ToolCallBatchOutcome =
  | { type: "completed" }
  | { type: "interrupted" }
  | { type: "suspended" };

/** 串行处理 ToolCall；Conversation Event 是恢复真相，Run Log 仅作审计镜像。 */
export class ToolCallExecutor {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly journal: RunJournal,
    private readonly interactions: HumanInteractionCoordinator,
    private readonly policyGetter?: ToolPolicyGetter
  ) {}

  async executeCall(
    conversation: Conversation,
    call: ToolCall,
    context: ToolContext,
    trace: ToolTrace
  ): Promise<ToolResult | { type: "suspended" }> {
    const existing = findToolResult(conversation, call.id);
    if (existing) return toToolResult(existing);

    const interaction = findApprovalForToolCall(conversation, call.id);
    if (interaction) {
      const resolved = findHumanInteractionResolution(
        conversation.getEvents(),
        interaction.interactionId
      );
      if (!resolved) return { type: "suspended" };
      if (
        resolved.resolution.kind === "cancelled" ||
        resolved.resolution.response.decision === "reject"
      ) {
        const reason =
          resolved.resolution.kind === "response"
            ? resolved.resolution.response.reason
            : undefined;
        await this.skipCall(
          conversation,
          call,
          trace,
          resolved.resolution.kind === "cancelled"
            ? "user_interrupt"
            : "approval_rejected",
          resolved.resolution.kind === "cancelled"
            ? "用户已打断，该工具未执行"
            : reason
              ? `工具调用未获批准：${reason}`
              : "工具调用未获批准"
        );
        return toToolResult(findToolResult(conversation, call.id)!);
      }
    }

    const tool = this.tools.get(call.name);
    if (!tool) {
      await this.skipCall(
        conversation,
        call,
        trace,
        "unknown_tool",
        `未知工具：${call.name}`
      );
      return toToolResult(findToolResult(conversation, call.id)!);
    }

    let parsed: unknown;
    try {
      parsed = tool.schema.parse(call.args);
    } catch (error) {
      await this.skipCall(
        conversation,
        call,
        trace,
        "invalid_arguments",
        `工具 ${call.name} 参数不合法：${errorMessage(error)}`
      );
      return toToolResult(findToolResult(conversation, call.id)!);
    }

    if (call.name !== "finish") {
      const evaluation = await evaluateToolPolicy({
        conversationId: conversation.id,
        mode: projectToolPolicyMode(conversation.getEvents()),
        getter: this.policyGetter,
        toolName: call.name,
        args: parsed,
      });
      if (evaluation.decision.type === "deny") {
        await this.skipCall(
          conversation,
          call,
          trace,
          evaluation.source === "getter_error" ? "policy_error" : "policy_denied",
          evaluation.decision.reason
        );
        return toToolResult(findToolResult(conversation, call.id)!);
      }
      if (evaluation.decision.type === "ask" && !interaction) {
        await this.interactions.requestApproval(conversation, {
          toolCallId: call.id,
          reason: evaluation.decision.reason,
          continuation: trace,
        });
        return { type: "suspended" };
      }
    }

    await this.journal.append({
      type: "tool_call_dispatched",
      runId: trace.runId,
      step: trace.step,
      llmCallId: trace.llmCallId,
      toolCallId: call.id,
      tool: call.name,
    });
    await conversation.emit({
      type: "tool_call_dispatched",
      source: "environment",
      toolCallId: call.id,
    });
    const startedAt = Date.now();
    let output;
    try {
      output = await tool.execute(parsed, context);
    } catch (error) {
      output = {
        content: `工具 ${call.name} 执行出错：${errorMessage(error)}`,
        isError: true,
      };
    }
    const resultEvent = await conversation.emit({
      type: "tool_result",
      source: "environment",
      toolCallId: call.id,
      content: output.content,
      isError: output.isError,
    });
    await this.journal.append({
      type: "tool_call_completed",
      runId: trace.runId,
      step: trace.step,
      llmCallId: trace.llmCallId,
      toolCallId: call.id,
      tool: call.name,
      outcome: output.isError ? "error" : "success",
      durationMs: Date.now() - startedAt,
      resultEventSeq: resultEvent.seq,
    });
    return {
      toolCallId: call.id,
      content: output.content,
      isError: output.isError,
    };
  }

  async skipCall(
    conversation: Conversation,
    call: ToolCall,
    trace: Omit<ToolTrace, "projectedThroughSeq">,
    reason:
      | "user_interrupt"
      | "finish_called"
      | "lifecycle_error"
      | "approval_rejected"
      | "policy_denied"
      | "policy_error"
      | "process_restarted"
      | "unknown_tool"
      | "invalid_arguments",
    content: string
  ): Promise<void> {
    if (findToolResult(conversation, call.id)) return;
    const resultEvent = await conversation.emit({
      type: "tool_result",
      source: "environment",
      toolCallId: call.id,
      content,
      isError: true,
    });
    await this.journal.append({
      type: "tool_call_skipped",
      runId: trace.runId,
      step: trace.step,
      llmCallId: trace.llmCallId,
      toolCallId: call.id,
      tool: call.name,
      reason,
      resultEventSeq: resultEvent.seq,
    });
  }

  async executeCalls(
    conversation: Conversation,
    calls: ToolCall[],
    context: ToolContext,
    trace: ToolTrace,
    signal?: AbortSignal
  ): Promise<ToolCallBatchOutcome> {
    for (const [index, call] of calls.entries()) {
      if (findToolResult(conversation, call.id)) continue;
      if (signal?.aborted) {
        for (const remaining of calls.slice(index)) {
          await this.skipCall(
            conversation,
            remaining,
            trace,
            "user_interrupt",
            "用户已打断，该工具未执行"
          );
        }
        return { type: "interrupted" };
      }
      const result = await this.executeCall(conversation, call, context, trace);
      if ("type" in result && result.type === "suspended") return result;
    }
    return { type: signal?.aborted ? "interrupted" : "completed" };
  }
}

type ToolResultEvent = Extract<
  ReturnType<Conversation["getEvents"]>[number],
  { type: "tool_result" }
>;

function findToolResult(
  conversation: Conversation,
  toolCallId: string
): ToolResultEvent | undefined {
  return conversation
    .getEvents()
    .find(
      (event): event is ToolResultEvent =>
        event.type === "tool_result" && event.toolCallId === toolCallId
    );
}

function findApprovalForToolCall(
  conversation: Conversation,
  toolCallId: string
): Extract<
  ReturnType<Conversation["getEvents"]>[number],
  { type: "human_interaction_requested" }
> | undefined {
  return conversation
    .getEvents()
    .find(
      (event): event is Extract<
        ReturnType<Conversation["getEvents"]>[number],
        { type: "human_interaction_requested" }
      > =>
        event.type === "human_interaction_requested" &&
        event.interactionType === "approval" &&
        event.request.target.toolCallId === toolCallId
    );
}

function toToolResult(event: ToolResultEvent): ToolResult {
  return {
    toolCallId: event.toolCallId,
    content: event.content,
    isError: event.isError,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
