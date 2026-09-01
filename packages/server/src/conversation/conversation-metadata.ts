/** Auto Compact 的稳定配置；由 Host 默认值在 Conversation 创建时解析。 */
export interface AutoCompactConfig {
  enabled: boolean;
  contextWindow: number;
  triggerRatio: number;
  targetRatio: number;
}

/** 一个持久 Conversation 恢复时必须保持不变的有效配置。 */
export interface ConversationConfig {
  tools: string[];
  maxSteps: number;
  maxModelAttemptsPerStep: number;
  autoCompact: AutoCompactConfig & { maxOutputTokens: number };
}

/** 当前持久化 metadata。 */
export interface ConversationMetadata {
  schemaVersion: 2;
  conversationId: string;
  createdAt: number;
  config: ConversationConfig;
}

/** schema v2 之前的持久格式，只允许在 Store 加载与 Service 迁移边界出现。 */
export interface LegacyConversationMetadata {
  schemaVersion: 1;
  conversationId: string;
  createdAt: number;
  tools?: string[];
}

export type StoredConversationMetadata =
  | ConversationMetadata
  | LegacyConversationMetadata;

export function isConversationMetadataCurrent(
  metadata: StoredConversationMetadata
): metadata is ConversationMetadata {
  return metadata.schemaVersion === 2;
}
