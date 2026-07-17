import { FsConversationStore } from "../conversation/conversation-store.js";
import { createLLMClient } from "../llm/factory.js";
import { FsRunLogStore } from "../observability/run-log-store.js";
import { makeAgentSessionFactory } from "./agent-session.js";
import {
  DefaultConversationService,
  type ConversationService,
} from "./conversation-service.js";
import {
  cleanupOrphanContainers,
  deriveDockerInstanceScope,
} from "../runtime/docker-runtime.js";
import { noopLogger } from "../logging/logger.js";
import type { TinyhandsHostOptions } from "./options.js";

/** framework-neutral 的 Tinyhands 服务端嵌入入口。 */
export interface TinyhandsHost {
  readonly conversations: ConversationService;
  /** 释放运行资源但保留 Conversation 数据；幂等。 */
  close(): Promise<void>;
}

class DefaultTinyhandsHost implements TinyhandsHost {
  private closePromise: Promise<void> | undefined;

  constructor(
    readonly conversations: ConversationService,
    private readonly cleanup: (() => Promise<void>) | undefined
  ) {}

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const closing = (async () => {
      await this.conversations.close();
      await this.cleanup?.();
    })();
    this.closePromise = closing;
    void closing.then(undefined, () => {
      if (this.closePromise === closing) this.closePromise = undefined;
    });
    return closing;
  }
}

/**
 * 只根据显式配置装配 Host：不读 env、不监听端口、不注册 signal、不清理全局容器。
 */
export async function createTinyhandsHost(
  config: TinyhandsHostOptions
): Promise<TinyhandsHost> {
  const logger = config.logger ?? noopLogger;
  const dockerInstanceScope =
    config.runtime.type === "docker"
      ? deriveDockerInstanceScope(config.workspaceRoot)
      : undefined;
  if (dockerInstanceScope) {
    await cleanupOrphanContainers(dockerInstanceScope, logger);
  }

  const llm = createLLMClient(config.llm);
  const conversationStore = new FsConversationStore(config.workspaceRoot, logger);
  const runLogStore = new FsRunLogStore(config.workspaceRoot, logger);
  const createSession = makeAgentSessionFactory({
    llm,
    maxStep: config.maxStep,
    runtime: config.runtime,
    dockerInstanceScope,
    logger,
    conversationStore,
    runLogStore,
    autoCompact: {
      config: config.llm.autoCompact,
      maxOutputTokens: config.llm.maxTokens,
    },
  });

  const conversations = new DefaultConversationService({
      workspaceRoot: config.workspaceRoot,
      createSession,
      conversationStore,
      logger,
    });
  return new DefaultTinyhandsHost(
    conversations,
    dockerInstanceScope
      ? () => cleanupOrphanContainers(dockerInstanceScope, logger)
      : undefined
  );
}
