import type { Conversation } from "../../conversation/conversation.js";
import type { ToolCall } from "../../llm/types.js";
import type { LLMRequestError } from "../../llm/llm-request-error.js";
import {
  noopLogger,
  type TinyhandsLogger,
} from "../../logging/logger.js";
import type { AgentStepCoordinates } from "../context/context-preparation.js";
import type { ToolTrace } from "./tool-call/tool-call-handler.js";
import { ToolCallHandler } from "./tool-call/tool-call-handler.js";

export type AgentErrorInput =
  | {
      source: "model_request";
      error: LLMRequestError;
      attempt: number;
      trace: ToolTrace;
    }
  | {
      source: "response" | "completion" | "tool_call";
      error: unknown;
      trace: ToolTrace;
      committedToolCalls?: readonly ToolCall[];
    }
  | {
      source: "context" | "unknown";
      error: unknown;
      coordinates: AgentStepCoordinates;
    };

export type AgentErrorOutcome =
  | { type: "retry" }
  | { type: "error"; message: string };

/** 非预期错误的稳定化、日志和已提交 ToolCall 补偿边界。 */
export class AgentErrorHandler {
  private readonly log: TinyhandsLogger;

  constructor(
    private readonly conversation: Conversation,
    private readonly toolCalls: ToolCallHandler,
    private readonly maxModelAttemptsPerStep: number,
    logger: TinyhandsLogger = noopLogger
  ) {
    this.log = logger.child({ module: "agent-error-handler" });
  }

  async handle(input: AgentErrorInput): Promise<AgentErrorOutcome> {
    this.log.error({
      source: input.source,
      error: input.error,
      ...(input.source === "model_request"
        ? { attempt: input.attempt, code: input.error.code }
        : {}),
    }, "Agent step failure");

    if (
      input.source === "model_request" &&
      input.error.retryable &&
      input.attempt < this.maxModelAttemptsPerStep
    ) {
      return { type: "retry" };
    }

    if (
      "committedToolCalls" in input &&
      input.committedToolCalls &&
      input.committedToolCalls.length > 0
    ) {
      await this.toolCalls.closePendingCalls(
        input.committedToolCalls,
        input.trace,
        "agent_error",
        "Agent 处理失败，该工具未执行"
      );
    }

    const message = stableMessage(input);
    await this.conversation.emit({
      type: "error",
      source: "agent",
      message,
    });
    return { type: "error", message };
  }
}

function stableMessage(input: AgentErrorInput): string {
  switch (input.source) {
    case "model_request":
      return `模型请求失败：${input.error.code}`;
    case "context":
      return "Agent 上下文准备失败";
    case "response":
      return "Agent 响应处理失败";
    case "completion":
      return "Agent 完成处理失败";
    case "tool_call":
      return "Agent 工具调用处理失败";
    case "unknown":
      return "Agent 执行失败";
  }
}
