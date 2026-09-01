import { randomUUID } from "node:crypto";
import type {
  RespondToInteractionInput,
  RespondToInteractionResult,
} from "@tinyhands/protocol";
import type { Conversation } from "../conversation/conversation.js";
import {
  findHumanInteractionRequest,
  findHumanInteractionResolution,
  findPendingHumanInteraction,
  type HumanInteractionRequested,
} from "../conversation/events.js";

export class InteractionNotFoundError extends Error {
  constructor(interactionId: string) {
    super(`human interaction 不存在：${interactionId}`);
  }
}

export class InteractionConflictError extends Error {}

export class HumanInteractionCoordinator {
  async requestApproval(
    conversation: Conversation,
    input: {
      toolCallId: string;
      reason: string;
      continuation: {
        runId: string;
        step: number;
        llmCallId: string;
        projectedThroughSeq: number;
      };
    }
  ): Promise<HumanInteractionRequested> {
    const pending = findPendingHumanInteraction(conversation.getEvents());
    if (pending) {
      throw new InteractionConflictError(
        `conversation 已有待处理 interaction：${pending.interactionId}`
      );
    }
    return conversation.emit({
      type: "human_interaction_requested",
      source: "environment",
      interactionId: randomUUID(),
      interactionType: "approval",
      request: {
        target: { type: "tool_call", toolCallId: input.toolCallId },
        reason: input.reason,
      },
      continuation: input.continuation,
    }) as Promise<HumanInteractionRequested>;
  }

  async respond(
    conversation: Conversation,
    interactionId: string,
    input: RespondToInteractionInput<"approval">
  ): Promise<RespondToInteractionResult> {
    const events = conversation.getEvents();
    const request = findHumanInteractionRequest(events, interactionId);
    if (!request) throw new InteractionNotFoundError(interactionId);
    if (request.interactionType !== input.interactionType) {
      throw new InteractionConflictError("interactionType 与原请求不匹配");
    }
    const existing = findHumanInteractionResolution(events, interactionId);
    if (existing) {
      const same =
        existing.resolution.kind === "response" &&
        JSON.stringify(existing.resolution.response) === JSON.stringify(input.response);
      if (!same) {
        throw new InteractionConflictError("interaction 已用不同响应解决");
      }
      return { interactionId, resolved: true };
    }
    await conversation.emit({
      type: "human_interaction_resolved",
      source: "user",
      interactionId,
      interactionType: "approval",
      resolution: { kind: "response", response: input.response },
    });
    return { interactionId, resolved: true };
  }

  async cancelPending(
    conversation: Conversation
  ): Promise<HumanInteractionRequested | undefined> {
    const pending = findPendingHumanInteraction(conversation.getEvents());
    if (!pending) return undefined;
    await conversation.emit({
      type: "human_interaction_resolved",
      source: "user",
      interactionId: pending.interactionId,
      interactionType: pending.interactionType,
      resolution: { kind: "cancelled", reason: "user_interrupt" },
    });
    return pending;
  }
}
