import type { Conversation } from "../../../conversation/conversation.js";
import { projectToolPolicyMode } from "../../../conversation/events.js";
import type { ToolCall, ToolResult } from "../../../llm/types.js";
import type { RunJournal } from "../../../observability/run-log.js";
import type { HumanInteractionCoordinator } from "../../../server/human-interaction.js";
import {
  evaluateToolPolicy,
  type ToolPolicyGetter,
} from "../../../tools/tool-policy.js";
import { ToolCallExecutor } from "./tool-call-executor.js";
import {
  findToolApproval,
  findToolResult,
  resolveToolApproval,
  toToolResult,
} from "./tool-call-state.js";

export interface ToolTrace {
  runId: string;
  step: number;
  llmCallId: string;
  projectedThroughSeq: number;
}

export type ToolCallSkipReason =
  | "user_interrupt"
  | "finish_called"
  | "agent_error"
  | "approval_rejected"
  | "policy_denied"
  | "policy_error"
  | "process_restarted"
  | "unknown_tool"
  | "invalid_arguments";

export type ToolCallHandlerOutcome =
  | { type: "completed"; results: readonly ToolResult[] }
  | { type: "suspended" }
  | { type: "interrupted" };

/** ToolCall 的策略、approval、Event、Run Log、配对和批次编排边界。 */
export class ToolCallHandler {
  constructor(
    private readonly conversation: Conversation,
    private readonly executor: ToolCallExecutor,
    private readonly journal: RunJournal,
    private readonly interactions: HumanInteractionCoordinator,
    private readonly policyGetter?: ToolPolicyGetter
  ) {}

  async handleCalls(input: {
    calls: readonly ToolCall[];
    trace: ToolTrace;
    signal?: AbortSignal;
    selectedToolCallId?: string;
  }): Promise<ToolCallHandlerOutcome> {
    const ordered = input.selectedToolCallId
      ? [
          ...input.calls.filter((call) => call.id === input.selectedToolCallId),
          ...input.calls.filter((call) => call.id !== input.selectedToolCallId),
        ]
      : [...input.calls];
    const results: ToolResult[] = [];

    for (const [index, call] of ordered.entries()) {
      const existing = findToolResult(this.conversation.getEvents(), call.id);
      if (existing) {
        results.push(toToolResult(existing));
        continue;
      }

      if (input.selectedToolCallId && call.id !== input.selectedToolCallId) {
        results.push(
          await this.skipCall(
            call,
            input.trace,
            "finish_called",
            "finish 已在本轮调用，该工具未执行"
          )
        );
        continue;
      }

      if (input.signal?.aborted) {
        for (const remaining of ordered.slice(index)) {
          if (findToolResult(this.conversation.getEvents(), remaining.id)) continue;
          await this.skipCall(
            remaining,
            input.trace,
            "user_interrupt",
            "用户已打断，该工具未执行"
          );
        }
        return { type: "interrupted" };
      }

      const outcome = await this.handleCall(call, input.trace, {
        skipPolicy: call.id === input.selectedToolCallId,
      });
      if (outcome.type === "suspended") return outcome;
      results.push(outcome.result);
    }

    return input.signal?.aborted
      ? { type: "interrupted" }
      : { type: "completed", results };
  }

  async closePendingCalls(
    calls: readonly ToolCall[],
    trace: Omit<ToolTrace, "projectedThroughSeq">,
    reason: ToolCallSkipReason,
    message: string
  ): Promise<void> {
    for (const call of calls) {
      if (findToolResult(this.conversation.getEvents(), call.id)) continue;
      await this.skipCall(call, trace, reason, message);
    }
  }

  private async handleCall(
    call: ToolCall,
    trace: ToolTrace,
    options: { skipPolicy: boolean }
  ): Promise<{ type: "completed"; result: ToolResult } | { type: "suspended" }> {
    const events = this.conversation.getEvents();
    const approval = findToolApproval(events, call.id);
    if (approval) {
      const resolution = resolveToolApproval(events, approval);
      if (!resolution) return { type: "suspended" };
      const rejected =
        resolution.resolution.kind === "response" &&
        resolution.resolution.response.decision === "reject";
      if (resolution.resolution.kind === "cancelled" || rejected) {
        const reason =
          resolution.resolution.kind === "response"
            ? resolution.resolution.response.reason
            : undefined;
        return {
          type: "completed",
          result: await this.skipCall(
            call,
            trace,
            rejected ? "approval_rejected" : "user_interrupt",
            rejected
              ? reason
                ? `工具调用未获批准：${reason}`
                : "工具调用未获批准"
              : "用户已打断，该工具未执行"
          ),
        };
      }
    }

    const prepared = this.executor.prepare(call);
    if (prepared.type === "error") {
      return {
        type: "completed",
        result: await this.skipCall(call, trace, prepared.reason, prepared.message),
      };
    }

    if (!options.skipPolicy) {
      const evaluation = await evaluateToolPolicy({
        conversationId: this.conversation.id,
        mode: projectToolPolicyMode(this.conversation.getEvents()),
        getter: this.policyGetter,
        toolName: call.name,
        args: prepared.value.args,
      });
      if (evaluation.decision.type === "deny") {
        return {
          type: "completed",
          result: await this.skipCall(
            call,
            trace,
            evaluation.source === "getter_error" ? "policy_error" : "policy_denied",
            evaluation.decision.reason
          ),
        };
      }
      if (evaluation.decision.type === "ask" && !approval) {
        await this.interactions.requestApproval(this.conversation, {
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
    await this.conversation.emit({
      type: "tool_call_dispatched",
      source: "environment",
      toolCallId: call.id,
    });
    const startedAt = Date.now();
    let output;
    try {
      output = await this.executor.execute(prepared.value);
    } catch (error) {
      output = {
        content: `工具 ${call.name} 执行出错：${errorMessage(error)}`,
        isError: true,
      };
    }
    const resultEvent = await this.conversation.emit({
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
      type: "completed",
      result: { toolCallId: call.id, content: output.content, isError: output.isError },
    };
  }

  private async skipCall(
    call: ToolCall,
    trace: Omit<ToolTrace, "projectedThroughSeq">,
    reason: ToolCallSkipReason,
    content: string
  ): Promise<ToolResult> {
    const existing = findToolResult(this.conversation.getEvents(), call.id);
    if (existing) return toToolResult(existing);
    const resultEvent = await this.conversation.emit({
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
    return { toolCallId: call.id, content, isError: true };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
