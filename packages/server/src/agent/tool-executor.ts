import type { Conversation } from "../conversation/conversation.js";
import type { ToolCall, ToolResult } from "../llm/types.js";
import type { RunJournal } from "../observability/run-log.js";
import type { ToolContext, ToolRegistry } from "../tools/tool.js";

export interface ToolTrace {
  runId: string;
  step: number;
  llmCallId: string;
}

export interface ToolBatchOutcome {
  type: "completed" | "interrupted";
}

/**
 * ToolExecutor 负责工具副作用、tool_result 配对及对应 Run Log。
 *
 * 它不识别 finish，也不决定 Agent 是否结束；这些协议语义属于单步编排层。
 */
export class ToolExecutor {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly journal: RunJournal
  ) {}

  async execute(
    conversation: Conversation,
    call: ToolCall,
    context: ToolContext,
    trace: ToolTrace
  ): Promise<ToolResult> {
    await this.journal.append({
      type: "tool_started",
      ...trace,
      toolCallId: call.id,
      tool: call.name,
    });
    const startedAt = Date.now();
    const result = await this.executeToolCall(call, context);
    const resultEvent = await conversation.emit({
      type: "tool_result",
      source: "environment",
      toolCallId: result.toolCallId,
      content: result.content,
      isError: result.isError,
    });
    await this.journal.append({
      type: "tool_completed",
      ...trace,
      toolCallId: call.id,
      tool: call.name,
      outcome: result.isError ? "error" : "success",
      durationMs: Date.now() - startedAt,
      resultEventSeq: resultEvent.seq,
    });
    return result;
  }

  async skip(
    conversation: Conversation,
    call: ToolCall,
    trace: ToolTrace,
    reason: "user_interrupt" | "finish_called",
    content: string
  ): Promise<void> {
    const resultEvent = await conversation.emit({
      type: "tool_result",
      source: "environment",
      toolCallId: call.id,
      content,
      isError: true,
    });
    await this.journal.append({
      type: "tool_skipped",
      ...trace,
      toolCallId: call.id,
      tool: call.name,
      reason,
      resultEventSeq: resultEvent.seq,
    });
  }

  async executeBatch(
    conversation: Conversation,
    calls: ToolCall[],
    context: ToolContext,
    trace: ToolTrace,
    signal?: AbortSignal
  ): Promise<ToolBatchOutcome> {
    for (const [index, call] of calls.entries()) {
      // 工具执行不可安全强杀；只在前一个工具自然结束后检查打断，并为剩余调用补配对。
      if (signal?.aborted) {
        for (const remaining of calls.slice(index)) {
          await this.skip(
            conversation,
            remaining,
            trace,
            "user_interrupt",
            "用户已打断，该工具未执行"
          );
        }
        return { type: "interrupted" };
      }
      await this.execute(conversation, call, context, trace);
    }

    // 接住最后一个工具执行期间发生的打断。
    return { type: signal?.aborted ? "interrupted" : "completed" };
  }

  /** 执行单个工具调用，返回按 id 配对好的 ToolResult。 */
  private async executeToolCall(
    call: ToolCall,
    context: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        toolCallId: call.id,
        content: `未知工具：${call.name}`,
        isError: true,
      };
    }

    try {
      const parsed = tool.schema.parse(call.args);
      const output = await tool.execute(parsed, context);
      return {
        toolCallId: call.id,
        content: output.content,
        isError: output.isError,
      };
    } catch (error) {
      return {
        toolCallId: call.id,
        content: `工具 ${call.name} 执行出错：${(error as Error).message}`,
        isError: true,
      };
    }
  }
}
