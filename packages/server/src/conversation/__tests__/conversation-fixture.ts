import { Conversation } from "../conversation.js";
import type { Event } from "../events.js";
import type { EventAppender } from "../conversation-store.js";
import type {
  ConversationConfig,
  ConversationMetadata,
} from "../conversation-metadata.js";
import type { TinyhandsLogger } from "../../logging/logger.js";

export const TEST_CONVERSATION_DEFAULTS: ConversationConfig = {
  tools: ["run_bash"],
  maxSteps: 10,
  maxModelAttemptsPerStep: 1,
  autoCompact: {
    enabled: false,
    contextWindow: 100_000,
    triggerRatio: 0.8,
    targetRatio: 0.5,
    maxOutputTokens: 4_096,
  },
};

export function testConversationMetadata(
  conversationId: string,
  overrides: Partial<ConversationConfig> = {}
): ConversationMetadata {
  return {
    schemaVersion: 2,
    conversationId,
    createdAt: 1,
    config: {
      ...TEST_CONVERSATION_DEFAULTS,
      ...overrides,
      tools: [...(overrides.tools ?? TEST_CONVERSATION_DEFAULTS.tools)],
      autoCompact: {
        ...TEST_CONVERSATION_DEFAULTS.autoCompact,
        ...overrides.autoCompact,
      },
    },
  };
}

export function createTestConversation(
  conversationId: string,
  options: {
    store?: EventAppender;
    initialEvents?: readonly Event[];
    logger?: TinyhandsLogger;
    config?: Partial<ConversationConfig>;
  } = {}
): Conversation {
  return new Conversation(testConversationMetadata(conversationId, options.config), {
    store: options.store,
    initialEvents: options.initialEvents,
    logger: options.logger,
  });
}
