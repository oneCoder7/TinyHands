import type { Conversation } from "../conversation/conversation.js";
import type { TinyhandsLogger } from "../logging/logger.js";
import type { LLMClient } from "../llm/llm-client.js";
import type { RunJournal } from "../observability/run-log.js";
import type { Runtime } from "../runtime/runtime.js";
import { HumanInteractionCoordinator } from "../server/human-interaction.js";
import type { ToolPolicyGetter } from "../tools/tool-policy.js";
import type { ToolRegistry } from "../tools/tool.js";
import { Agent } from "./agent.js";
import { AgentRecovery } from "./agent-recovery.js";
import { AgentLLMCall } from "./step/agent-llm-call.js";
import { BuiltInContextPreparation } from "./context/built-in-context-preparation.js";
import { CompactionRecovery } from "./context/compaction-recovery.js";
import type { ContextPreparation } from "./context/context-preparation.js";
import type { ContextCompactor } from "./context/context-compactor.js";
import { AgentErrorHandler } from "./step/agent-error-handler.js";
import { AgentStepExecutor } from "./step/agent-step-executor.js";
import { FinishCompletionHandler } from "./step/finish-completion-handler.js";
import {
  assertUniqueResponseValidatorIds,
  type ResponseValidator,
} from "./step/response-validator.js";
import { StopReasonValidator } from "./step/stop-reason-validator.js";
import { ToolCallExecutor } from "./step/tool-call/tool-call-executor.js";
import { ToolCallHandler } from "./step/tool-call/tool-call-handler.js";

export interface CreateAgentOptions {
  conversation: Conversation;
  runtime: Runtime;
  llm: LLMClient;
  tools: ToolRegistry;
  journal: RunJournal;
  compactor?: Pick<ContextCompactor, "prepare">;
  contextPreparation?: ContextPreparation;
  maxStep: number;
  maxModelAttemptsPerStep: number;
  toolPolicyGetter?: ToolPolicyGetter;
  responseValidators?: readonly ResponseValidator[];
  interactions?: HumanInteractionCoordinator;
  logger?: TinyhandsLogger;
}

export interface CreatedAgent {
  agent: Agent;
  recovery: AgentRecovery;
}

/** 每个 Conversation 执行实例唯一的 Agent 装配入口。 */
export function createAgent(options: CreateAgentOptions): CreatedAgent {
  if (
    !Number.isInteger(options.maxModelAttemptsPerStep) ||
    options.maxModelAttemptsPerStep < 1
  ) {
    throw new Error("maxModelAttemptsPerStep 必须是正整数");
  }

  const toolSnapshot = options.tools.list();
  const interactions = options.interactions ?? new HumanInteractionCoordinator();
  const toolExecutor = new ToolCallExecutor(options.tools, {
    runtime: options.runtime,
  });
  const toolCallHandler = new ToolCallHandler(
    options.conversation,
    toolExecutor,
    options.journal,
    interactions,
    options.toolPolicyGetter
  );
  const errorHandler = new AgentErrorHandler(
    options.conversation,
    toolCallHandler,
    options.maxModelAttemptsPerStep,
    options.logger
  );
  const validators: ResponseValidator[] = [
    new StopReasonValidator(),
    ...(options.responseValidators ?? []),
  ];
  assertUniqueResponseValidatorIds(validators);
  const contextPreparation =
    options.contextPreparation ??
    new BuiltInContextPreparation(toolSnapshot, options.compactor);
  if (!contextPreparation.id) {
    throw new Error("Context Preparation ID 不能为空");
  }

  const step = new AgentStepExecutor({
    conversation: options.conversation,
    tools: toolSnapshot,
    journal: options.journal,
    contextPreparation,
    llmCall: new AgentLLMCall(options.llm, options.journal),
    responseValidators: validators,
    completionHandler: new FinishCompletionHandler(toolCallHandler),
    toolCallHandler,
    errorHandler,
  });

  return {
    agent: new Agent(options.conversation, step, errorHandler, options.maxStep),
    recovery: new AgentRecovery(
      options.conversation,
      options.journal,
      toolCallHandler,
      new CompactionRecovery(options.conversation),
      options.logger
    ),
  };
}
