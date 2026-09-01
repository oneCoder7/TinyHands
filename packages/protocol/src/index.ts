export const TINYHANDS_PROTOCOL_VERSION = 2 as const;

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ThinkingBlock {
  thinking: string;
  signature: string;
}

export type Delta =
  | { kind: "thinking"; phase: "start" }
  | { kind: "thinking"; phase: "chunk"; text: string }
  | { kind: "thinking"; phase: "end" };

export type EventSource = "user" | "agent" | "environment";

interface BasePublicEvent {
  id: string;
  seq: number;
  timestamp: number;
  source: EventSource;
}

export type CompactionFailureCode =
  | "summary_invalid"
  | "summary_too_large"
  | "no_safe_boundary"
  | "single_segment_overflow"
  | "provider_error"
  | "persistence_error";

export type ToolPolicyMode =
  | "request_approval"
  | "default"
  | "full_access";

export interface ConversationToolPolicyInput {
  mode: ToolPolicyMode;
}

export interface HumanInteractionRequestMap {
  approval: {
    target: { type: "tool_call"; toolCallId: string };
    reason: string;
  };
}

export interface HumanInteractionResponseMap {
  approval: {
    decision: "approve" | "reject";
    reason?: string;
  };
}

export type HumanInteractionType = keyof HumanInteractionRequestMap;

export type HumanInteractionRequestedEvent = {
  [K in HumanInteractionType]: BasePublicEvent & {
    type: "human_interaction_requested";
    source: "environment";
    interactionId: string;
    interactionType: K;
    request: HumanInteractionRequestMap[K];
  };
}[HumanInteractionType];

export type HumanInteractionResolvedEvent = {
  [K in HumanInteractionType]: BasePublicEvent & {
    type: "human_interaction_resolved";
    source: "user";
    interactionId: string;
    interactionType: K;
    resolution:
      | { kind: "response"; response: HumanInteractionResponseMap[K] }
      | { kind: "cancelled"; reason: "user_interrupt" };
  };
}[HumanInteractionType];

export type PublicEvent =
  | (BasePublicEvent & {
      type: "user_message";
      text: string;
      triggerId?: string;
    })
  | (BasePublicEvent & {
      type: "agent_message";
      text: string;
      toolCalls: ToolCall[];
    })
  | (BasePublicEvent & {
      type: "tool_result";
      toolCallId: string;
      content: string;
      isError: boolean;
    })
  | (BasePublicEvent & { type: "thinking_completed"; blocks: ThinkingBlock[] })
  | (BasePublicEvent & { type: "error"; message: string })
  | (BasePublicEvent & { type: "agent_completed"; result: string })
  | (BasePublicEvent & { type: "interrupted" })
  | (BasePublicEvent & {
      type: "tool_policy_mode_changed";
      source: "environment";
      mode: ToolPolicyMode;
    })
  | HumanInteractionRequestedEvent
  | HumanInteractionResolvedEvent
  | (BasePublicEvent & {
      type: "compaction_started";
      compactionId: string;
      reason: "threshold";
      estimatedTokens: number;
      triggerTokens: number;
    })
  | (BasePublicEvent & {
      type: "compaction_completed";
      compactionId: string;
      throughSeq: number;
      estimatedBeforeTokens: number;
      estimatedAfterTokens: number;
    })
  | (BasePublicEvent & {
      type: "compaction_cancelled";
      compactionId: string;
      reason: "user_interrupt" | "process_restarted";
    })
  | (BasePublicEvent & {
      type: "compaction_failed";
      compactionId: string;
      code: CompactionFailureCode;
    });

export type PublicStreamItem = PublicEvent | { delta: Delta };

export interface CreateConversationInput {
  conversationId?: string;
  tools?: string[];
  toolPolicy?: ConversationToolPolicyInput;
}

export interface ConversationInfo {
  conversationId: string;
  createdAt: number;
  running: boolean;
}

export interface ConversationListResult {
  conversations: ConversationInfo[];
}

export interface SendMessageInput {
  text: string;
}

export interface SendMessageResult {
  accepted: true;
  running: boolean;
  triggerId: string;
}

export interface InterruptResult {
  interrupted: boolean;
}

export interface DeleteConversationResult {
  deleted: true;
}

export interface SetToolPolicyResult {
  mode: ToolPolicyMode;
  changed: boolean;
}

export type RespondToInteractionInput<K extends HumanInteractionType> = {
  interactionType: K;
  response: HumanInteractionResponseMap[K];
};

export interface RespondToInteractionResult {
  interactionId: string;
  resolved: true;
}

export type TinyhandsErrorCode =
  | "invalid_argument"
  | "conversation_exists"
  | "conversation_not_found"
  | "conversation_deleted"
  | "conversation_closing"
  | "conversation_recovery_failed"
  | "conversation_waiting_for_interaction"
  | "interaction_not_found"
  | "interaction_conflict"
  | "persistence_failed"
  | "runtime_cleanup_failed"
  | "event_stream_overflow"
  | "host_closing"
  | "host_closed"
  | "internal_error";

export interface TinyhandsErrorBody {
  error: {
    code: TinyhandsErrorCode;
    message: string;
  };
}

export interface StreamClosedControl {
  type: "stream_closed";
  code:
    | "conversation_deleted"
    | "event_stream_overflow"
    | "host_closing"
    | "host_closed";
  message: string;
}

export type EventSubscriptionCloseReason =
  | "observer_closed"
  | "conversation_deleted"
  | "event_stream_overflow"
  | "host_closing"
  | "host_closed";

export type TinyhandsAction =
  | "conversation:create"
  | "conversation:list"
  | "conversation:read"
  | "conversation:send"
  | "conversation:interrupt"
  | "conversation:set_tool_policy"
  | "conversation:respond_interaction"
  | "conversation:delete";

export function isPublicStreamItem(value: unknown): value is PublicStreamItem {
  if (!isRecord(value)) return false;
  if ("delta" in value) {
    const delta = value.delta;
    return (
      isRecord(delta) &&
      delta.kind === "thinking" &&
      (delta.phase === "start" ||
        delta.phase === "end" ||
        (delta.phase === "chunk" && typeof delta.text === "string"))
    );
  }
  return (
    typeof value.type === "string" &&
    PUBLIC_EVENT_TYPES.has(value.type as PublicEvent["type"]) &&
    !(
      value.type === "agent_message" &&
      ("providerReplay" in value || "executionTrace" in value)
    ) &&
    !(
      value.type === "human_interaction_requested" &&
      "continuation" in value
    ) &&
    typeof value.id === "string" &&
    Number.isSafeInteger(value.seq) &&
    typeof value.timestamp === "number" &&
    (value.source === "user" ||
      value.source === "agent" ||
      value.source === "environment")
  );
}

export function isTinyhandsErrorBody(value: unknown): value is TinyhandsErrorBody {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    TINYHANDS_ERROR_CODES.has(value.error.code as TinyhandsErrorCode) &&
    typeof value.error.message === "string"
  );
}

const PUBLIC_EVENT_TYPES = new Set<PublicEvent["type"]>([
  "user_message",
  "agent_message",
  "tool_result",
  "thinking_completed",
  "error",
  "agent_completed",
  "interrupted",
  "tool_policy_mode_changed",
  "human_interaction_requested",
  "human_interaction_resolved",
  "compaction_started",
  "compaction_completed",
  "compaction_cancelled",
  "compaction_failed",
]);

const TINYHANDS_ERROR_CODES = new Set<TinyhandsErrorCode>([
  "invalid_argument",
  "conversation_exists",
  "conversation_not_found",
  "conversation_deleted",
  "conversation_closing",
  "conversation_recovery_failed",
  "conversation_waiting_for_interaction",
  "interaction_not_found",
  "interaction_conflict",
  "persistence_failed",
  "runtime_cleanup_failed",
  "event_stream_overflow",
  "host_closing",
  "host_closed",
  "internal_error",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
