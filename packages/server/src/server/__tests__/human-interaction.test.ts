import { describe, expect, it } from "vitest";
import { Conversation } from "../../conversation/conversation.js";
import { createTestConversation } from "../../conversation/__tests__/conversation-fixture.js";
import {
  HumanInteractionCoordinator,
  InteractionConflictError,
} from "../human-interaction.js";

describe("HumanInteractionCoordinator", () => {
  it("相同响应幂等，不同响应冲突", async () => {
    const conversation = createTestConversation("c1");
    const coordinator = new HumanInteractionCoordinator();
    const request = await coordinator.requestApproval(conversation, {
      toolCallId: "t1",
      reason: "needs approval",
      continuation: {
        runId: "r1",
        step: 0,
        llmCallId: "l1",
        projectedThroughSeq: 1,
      },
    });
    const input = {
      interactionType: "approval" as const,
      response: { decision: "approve" as const },
    };

    await coordinator.respond(conversation, request.interactionId, input);
    await coordinator.respond(conversation, request.interactionId, input);
    expect(conversation.getEvents().filter(
      (event) => event.type === "human_interaction_resolved"
    )).toHaveLength(1);
    await expect(coordinator.respond(conversation, request.interactionId, {
      interactionType: "approval",
      response: { decision: "reject" },
    })).rejects.toBeInstanceOf(InteractionConflictError);
  });

  it("同一 Conversation 同时只允许一个 unresolved interaction", async () => {
    const conversation = createTestConversation("c2");
    const coordinator = new HumanInteractionCoordinator();
    const continuation = {
      runId: "r1",
      step: 0,
      llmCallId: "l1",
      projectedThroughSeq: 1,
    };
    await coordinator.requestApproval(conversation, {
      toolCallId: "t1",
      reason: "first",
      continuation,
    });
    await expect(coordinator.requestApproval(conversation, {
      toolCallId: "t2",
      reason: "second",
      continuation,
    })).rejects.toBeInstanceOf(InteractionConflictError);
  });
});
