import {
  projectCompactedContext,
  type Event,
} from "../conversation/events.js";
import type {
  LLMResponse,
  Message,
  ToolCall,
} from "../llm/types.js";
import type { Tool } from "../tools/tool.js";
import {
  CompactionError,
  type ContextCompactorLike,
} from "./context-compactor.js";

export interface PreparedContext {
  messages: Message[];
  systemContext: string[];
}

export interface PrepareContextInput {
  events: readonly Event[];
  tools: readonly Tool[];
  runId: string;
  step: number;
  signal?: AbortSignal;
}

export interface ContextPreparation {
  readonly id: string;
  prepare(input: Readonly<PrepareContextInput>): Promise<PreparedContext>;
}

export interface ModelRequestFailure {
  error: unknown;
  /** 当前 Step 内第几次模型调用，从 1 开始。 */
  attempt: number;
}

export type RequestErrorDecision = "retry" | "fail";

export interface RequestErrorResolver {
  readonly id: string;
  resolve(
    failure: Readonly<ModelRequestFailure>
  ): Promise<RequestErrorDecision | undefined>;
}

export interface ResponseRejection {
  reason: "max_tokens" | "content_filter" | "refusal";
  message: string;
}

export interface ResponseValidator {
  readonly id: string;
  validate(
    stopReason: LLMResponse["stopReason"]
  ): Promise<ResponseRejection | undefined>;
}

export type CommittedResponsePlan =
  | { type: "continue"; contextMessage: string }
  | {
      type: "execute_completion_tool";
      toolCallId: string;
      onErrorContextMessage: string;
    };

export interface CommittedResponsePolicy {
  readonly id: string;
  plan(
    toolCalls: readonly ToolCall[]
  ): Promise<CommittedResponsePlan | undefined>;
}

export type AgentLifecyclePhase =
  | "prepare_context"
  | "request_error"
  | "inspect_response"
  | "committed_response";

/** 不把扩展原始异常正文带到稳定业务错误中。 */
export class AgentLifecycleError extends Error {
  constructor(
    readonly phase: AgentLifecyclePhase,
    readonly componentId: string
  ) {
    super(`Agent 生命周期组件失败：${phase}/${componentId}`);
    this.name = "AgentLifecycleError";
  }
}

export interface AgentLifecycleOptions {
  contextPreparation: ContextPreparation;
  requestErrorResolvers?: readonly RequestErrorResolver[];
  responseValidators?: readonly ResponseValidator[];
  committedResponsePolicies?: readonly CommittedResponsePolicy[];
}

/**
 * 四个生命周期位置的固定调度器。它只组合阶段结果，不接触 Conversation 或 Run Log。
 */
export class AgentLifecycle {
  private readonly contextPreparation: ContextPreparation;
  private readonly requestErrorResolvers: readonly RequestErrorResolver[];
  private readonly responseValidators: readonly ResponseValidator[];
  private readonly committedResponsePolicies: readonly CommittedResponsePolicy[];

  constructor(options: AgentLifecycleOptions) {
    this.contextPreparation = options.contextPreparation;
    this.requestErrorResolvers = [...(options.requestErrorResolvers ?? [])];
    this.responseValidators = [...(options.responseValidators ?? [])];
    this.committedResponsePolicies = [
      ...(options.committedResponsePolicies ?? []),
    ];
    assertUniqueComponentIds([
      this.contextPreparation,
      ...this.requestErrorResolvers,
      ...this.responseValidators,
      ...this.committedResponsePolicies,
    ]);
  }

  async prepareContext(input: PrepareContextInput): Promise<PreparedContext> {
    try {
      const prepared = await this.contextPreparation.prepare(input);
      if (
        !Array.isArray(prepared?.messages) ||
        !Array.isArray(prepared?.systemContext)
      ) {
        throw new Error("非法 PreparedContext");
      }
      return prepared;
    } catch (error) {
      // Compactor 的稳定业务错误由 Step 单独映射，不能抹平成扩展错误。
      if (error instanceof CompactionError) {
        throw error;
      }
      throw new AgentLifecycleError(
        "prepare_context",
        this.contextPreparation.id
      );
    }
  }

  async resolveRequestError(
    failure: ModelRequestFailure
  ): Promise<RequestErrorDecision> {
    for (const resolver of this.requestErrorResolvers) {
      let decision: RequestErrorDecision | undefined;
      try {
        decision = await resolver.resolve(failure);
      } catch {
        throw new AgentLifecycleError("request_error", resolver.id);
      }
      if (decision === undefined) continue;
      if (decision !== "retry" && decision !== "fail") {
        throw new AgentLifecycleError("request_error", resolver.id);
      }
      return decision;
    }
    return "fail";
  }

  async inspectResponse(
    stopReason: LLMResponse["stopReason"]
  ): Promise<ResponseRejection | undefined> {
    for (const validator of this.responseValidators) {
      let rejection: ResponseRejection | undefined;
      try {
        rejection = await validator.validate(stopReason);
      } catch {
        throw new AgentLifecycleError("inspect_response", validator.id);
      }
      if (rejection === undefined) continue;
      if (
        !isRejectionReason(rejection.reason) ||
        typeof rejection.message !== "string" ||
        rejection.message.length === 0
      ) {
        throw new AgentLifecycleError("inspect_response", validator.id);
      }
      return rejection;
    }
    return undefined;
  }

  async planCommittedResponse(
    toolCalls: readonly ToolCall[]
  ): Promise<CommittedResponsePlan | undefined> {
    for (const policy of this.committedResponsePolicies) {
      let plan: CommittedResponsePlan | undefined;
      try {
        plan = await policy.plan(toolCalls);
      } catch {
        throw new AgentLifecycleError("committed_response", policy.id);
      }
      if (plan === undefined) continue;
      if (!isValidCommittedResponsePlan(plan, toolCalls)) {
        throw new AgentLifecycleError("committed_response", policy.id);
      }
      return plan;
    }
    return undefined;
  }
}

class BuiltInContextPreparation implements ContextPreparation {
  readonly id = "builtin.context-preparation";

  constructor(private readonly compactor?: ContextCompactorLike) {}

  async prepare(input: PrepareContextInput): Promise<PreparedContext> {
    if (this.compactor) {
      const prepared = await this.compactor.prepare(
        [...input.events],
        [...input.tools],
        {
          runId: input.runId,
          step: input.step,
          signal: input.signal,
        }
      );
      return {
        messages: prepared.messages,
        systemContext: prepared.systemContext,
      };
    }
    const projected = projectCompactedContext([...input.events]);
    return {
      messages: projected.messages,
      systemContext: projected.systemContext,
    };
  }
}

class StopReasonValidator implements ResponseValidator {
  readonly id = "builtin.stop-reason-validator";

  async validate(
    stopReason: LLMResponse["stopReason"]
  ): Promise<ResponseRejection | undefined> {
    switch (stopReason) {
      case "max_tokens":
        return {
          reason: stopReason,
          message: "LLM 输出被截断，本轮结果不可信",
        };
      case "content_filter":
        return {
          reason: stopReason,
          message: "LLM 输出被内容过滤，本轮未执行",
        };
      case "refusal":
        return {
          reason: stopReason,
          message: "LLM 拒绝了本轮请求，本轮未执行",
        };
      default:
        return undefined;
    }
  }
}

class FinishPolicy implements CommittedResponsePolicy {
  readonly id = "builtin.finish-policy";

  async plan(
    toolCalls: readonly ToolCall[]
  ): Promise<CommittedResponsePlan | undefined> {
    const finishCall = toolCalls.find((call) => call.name === "finish");
    if (finishCall) {
      return {
        type: "execute_completion_tool",
        toolCallId: finishCall.id,
        onErrorContextMessage:
          "finish 调用的参数有误，请检查后重新调用 finish 工具。",
      };
    }
    if (toolCalls.length === 0) {
      return {
        type: "continue",
        contextMessage:
          "如果任务已经完成，请调用 finish 工具给出最终答复；" +
          "如果还需要继续操作，请发起相应的工具调用。",
      };
    }
    return undefined;
  }
}

export function createBuiltInAgentLifecycle(options: {
  compactor?: ContextCompactorLike;
  requestErrorResolvers?: readonly RequestErrorResolver[];
  responseValidators?: readonly ResponseValidator[];
  committedResponsePolicies?: readonly CommittedResponsePolicy[];
} = {}): AgentLifecycle {
  return new AgentLifecycle({
    contextPreparation: new BuiltInContextPreparation(options.compactor),
    requestErrorResolvers: options.requestErrorResolvers,
    responseValidators: [
      new StopReasonValidator(),
      ...(options.responseValidators ?? []),
    ],
    committedResponsePolicies: [
      new FinishPolicy(),
      ...(options.committedResponsePolicies ?? []),
    ],
  });
}

function assertUniqueComponentIds(components: readonly { id: string }[]): void {
  const ids = new Set<string>();
  for (const component of components) {
    if (typeof component.id !== "string" || component.id.length === 0) {
      throw new Error("Agent 生命周期组件 ID 不能为空");
    }
    if (ids.has(component.id)) {
      throw new Error(`Agent 生命周期组件 ID 重复：${component.id}`);
    }
    ids.add(component.id);
  }
}

function isRejectionReason(
  value: unknown
): value is ResponseRejection["reason"] {
  return (
    value === "max_tokens" ||
    value === "content_filter" ||
    value === "refusal"
  );
}

function isValidCommittedResponsePlan(
  plan: CommittedResponsePlan,
  toolCalls: readonly ToolCall[]
): boolean {
  if (plan.type === "continue") {
    return (
      toolCalls.length === 0 &&
      typeof plan.contextMessage === "string" &&
      plan.contextMessage.length > 0
    );
  }
  return (
    typeof plan.toolCallId === "string" &&
    toolCalls.some((call) => call.id === plan.toolCallId) &&
    typeof plan.onErrorContextMessage === "string" &&
    plan.onErrorContextMessage.length > 0
  );
}
