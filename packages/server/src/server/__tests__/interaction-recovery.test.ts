import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FsConversationStore } from "../../conversation/conversation-store.js";
import type { LLMClient } from "../../llm/llm-client.js";
import { FsRunLogStore } from "../../observability/run-log-store.js";
import { makeAgentSessionFactory } from "../agent-session-factory.js";
import { TEST_CONVERSATION_DEFAULTS } from "../../conversation/__tests__/conversation-fixture.js";
import { DefaultConversationService } from "../conversation-service.js";

describe("Human Interaction recovery", () => {
  it("重建 Host 后保留 pending approval，并继续原 run", async () => {
    const root = mkdtempSync(join(tmpdir(), "tinyhands-hil-recovery-"));
    const conversationStore = new FsConversationStore(root);
    const runLogStore = new FsRunLogStore(root);
    const chat = vi
      .fn<LLMClient["chat"]>()
      .mockResolvedValueOnce({
        stopReason: "tool_call",
        text: "",
        toolCalls: [{
          id: "write-1",
          name: "write_file",
          args: { path: "approved.txt", content: "ok" },
        }],
        usage: { status: "not_reported" },
      })
      .mockResolvedValueOnce({
        stopReason: "tool_call",
        text: "",
        toolCalls: [
          { id: "finish-1", name: "finish", args: { result: "done" } },
        ],
        usage: { status: "not_reported" },
      });
    const llm: LLMClient = {
      identity: { provider: "test", model: "model", apiMode: "messages" },
      chat,
    };
    const makeService = () => new DefaultConversationService({
      workspaceRoot: root,
      conversationStore,
      conversationDefaults: {
        ...TEST_CONVERSATION_DEFAULTS,
        maxSteps: 3,
      },
      createSession: makeAgentSessionFactory({
        llm,
        runtime: { type: "local" },
        conversationStore,
        runLogStore,
      }),
    });

    const first = makeService();
    await first.create({ conversationId: "c1", tools: [] });
    await first.send("c1", "go");
    await vi.waitFor(async () => {
      const persisted = await conversationStore.load("c1");
      expect(persisted?.events.some(
        (event) => event.type === "human_interaction_requested"
      )).toBe(true);
    });
    const persisted = await conversationStore.load("c1");
    const request = persisted?.events.find(
      (event) => event.type === "human_interaction_requested"
    );
    if (!request || request.type !== "human_interaction_requested") {
      throw new Error("missing persisted interaction");
    }
    await first.close();

    const second = makeService();
    const subscription = await second.events("c1");
    await subscription.close();
    expect(chat).toHaveBeenCalledTimes(1);
    await second.respondToInteraction("c1", request.interactionId, {
      interactionType: "approval",
      response: { decision: "approve" },
    });
    await vi.waitFor(async () => {
      const resumed = await conversationStore.load("c1");
      expect(resumed?.events.at(-1)).toMatchObject({
        type: "agent_completed",
        result: "done",
      });
    });

    const records = await runLogStore.loadAndRepair("c1");
    expect(records.filter((record) => record.type === "run_started")).toHaveLength(1);
    expect(records.filter((record) => record.type === "run_completed")).toHaveLength(1);
    await second.close();
  });
});
