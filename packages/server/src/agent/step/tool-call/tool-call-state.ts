import type { Conversation } from "../../../conversation/conversation.js";
import {
  findHumanInteractionResolution,
  type HumanInteractionResolved,
  type Event,
} from "../../../conversation/events.js";
import type { ToolResult } from "../../../llm/types.js";

export type ToolResultEvent = Extract<Event, { type: "tool_result" }>;
export type ToolApprovalEvent = Extract<
  Event,
  { type: "human_interaction_requested" }
>;

export function findToolResult(
  events: readonly Event[],
  toolCallId: string
): ToolResultEvent | undefined {
  return events.find(
    (event): event is ToolResultEvent =>
      event.type === "tool_result" && event.toolCallId === toolCallId
  );
}

export function findToolApproval(
  events: readonly Event[],
  toolCallId: string
): ToolApprovalEvent | undefined {
  return events.find(
    (event): event is ToolApprovalEvent =>
      event.type === "human_interaction_requested" &&
      event.interactionType === "approval" &&
      event.request.target.toolCallId === toolCallId
  );
}

export function resolveToolApproval(
  events: readonly Event[],
  approval: ToolApprovalEvent
): HumanInteractionResolved | undefined {
  return findHumanInteractionResolution(events, approval.interactionId);
}

export function isToolCallDispatched(
  events: readonly Event[],
  toolCallId: string
): boolean {
  return events.some(
    (event) =>
      event.type === "tool_call_dispatched" && event.toolCallId === toolCallId
  );
}

export function toToolResult(event: ToolResultEvent): ToolResult {
  return {
    toolCallId: event.toolCallId,
    content: event.content,
    isError: event.isError,
  };
}

export function conversationEvents(conversation: Conversation): readonly Event[] {
  return conversation.getEvents();
}
