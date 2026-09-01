import type { LLMClient } from "../llm/llm-client.js";
import { Conversation } from "../conversation/conversation.js";
import type { Event } from "../conversation/events.js";
import type { ConversationMetadata } from "../conversation/conversation-metadata.js";
import type { ConversationStore } from "../conversation/conversation-store.js";
import { createAgent } from "../agent/create-agent.js";
import { ContextCompactor } from "../agent/context/context-compactor.js";
import { LocalRuntime } from "../runtime/local-runtime.js";
import { DockerRuntime } from "../runtime/docker-runtime.js";
import { OpenSandboxRuntime } from "../runtime/opensandbox-runtime.js";
import { ToolRegistry } from "../tools/tool.js";
import { readFileTool } from "../tools/read-file.js";
import { writeFileTool } from "../tools/write-file.js";
import { finishTool } from "../tools/finish.js";
import { optionalToolCatalog } from "../tools/catalog.js";
import { RunJournal } from "../observability/run-log.js";
import type { RunLogStore } from "../observability/run-log-store.js";
import type { TinyhandsRuntimeConfig } from "./options.js";
import type { ToolPolicyGetter } from "../tools/tool-policy.js";
import type { TinyhandsLogger } from "../logging/logger.js";
import { AgentSession } from "./agent-session.js";

export interface AgentSessionFactoryInput {
  metadata: ConversationMetadata;
  workspaceDir: string;
  initialEvents?: readonly Event[];
}

export type AgentSessionFactory = (
  input: AgentSessionFactoryInput
) => Promise<AgentSession>;

/**
 * 单 Conversation 的唯一装配入口。
 * metadata 在 ConversationService 中解析完成；这里不再处理默认值或恢复优先级。
 */
export function makeAgentSessionFactory(deps: {
  llm: LLMClient;
  runtime: TinyhandsRuntimeConfig;
  dockerInstanceScope?: string;
  logger?: TinyhandsLogger;
  conversationStore: ConversationStore;
  runLogStore: RunLogStore;
  toolPolicyGetter?: ToolPolicyGetter;
}): AgentSessionFactory {
  return async ({ metadata, workspaceDir, initialEvents }) => {
    const registry = new ToolRegistry()
      .register(readFileTool)
      .register(writeFileTool)
      .register(finishTool);

    for (const name of metadata.config.tools) {
      const tool = optionalToolCatalog.get(name);
      if (!tool) {
        throw new Error(
          `未知的可选工具："${name}"。可用工具：${[
            ...optionalToolCatalog.keys(),
          ].join(", ")}`
        );
      }
      registry.register(tool);
    }

    const journal = await RunJournal.open(
      metadata.conversationId,
      deps.runLogStore
    );
    const conversation = new Conversation(metadata, {
      store: deps.conversationStore,
      initialEvents,
      logger: deps.logger,
    });
    const runtime = (() => {
      switch (deps.runtime.type) {
        case "docker":
          if (!deps.dockerInstanceScope) {
            throw new Error("Docker runtime 缺少 instance scope");
          }
          return new DockerRuntime({
            image: deps.runtime.image,
            conversationId: metadata.conversationId,
            instanceScope: deps.dockerInstanceScope,
            logger: deps.logger,
          });
        case "opensandbox":
          return new OpenSandboxRuntime({
            serverUrl: deps.runtime.serverUrl,
            apiKey: deps.runtime.apiKey,
            image: deps.runtime.image,
            logger: deps.logger,
          });
        default:
          return new LocalRuntime({ cwd: workspaceDir });
      }
    })();
    const compactor = new ContextCompactor(
      deps.llm,
      journal,
      metadata.config.autoCompact,
      metadata.config.autoCompact.maxOutputTokens,
      conversation
    );
    const execution = createAgent({
      conversation,
      runtime,
      llm: deps.llm,
      tools: registry,
      journal,
      compactor,
      maxStep: metadata.config.maxSteps,
      maxModelAttemptsPerStep: metadata.config.maxModelAttemptsPerStep,
      toolPolicyGetter: deps.toolPolicyGetter,
      logger: deps.logger,
    });

    return new AgentSession({
      conversation,
      agent: execution.agent,
      recovery: execution.recovery,
      journal,
      runtime,
      logger: deps.logger,
    });
  };
}
