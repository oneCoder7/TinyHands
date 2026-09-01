import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { Conversation } from "../../conversation/conversation.js";
import type { RunLogRecord } from "../../observability/run-log.js";
import { RunJournal } from "../../observability/run-log.js";
import type { RunLogStore } from "../../observability/run-log-store.js";
import { HumanInteractionCoordinator } from "../../server/human-interaction.js";
import { ToolRegistry, type Tool } from "../../tools/tool.js";
import { ToolCallExecutor } from "../tool-call-executor.js";

class MemoryRunLogStore implements RunLogStore {
  records: RunLogRecord[] = [];
  async loadAndRepair() { return [...this.records]; }
  async append(_conversationId: string, record: RunLogRecord) {
    this.records.push(record);
  }
  async remove() {}
}

describe("ToolCallExecutor approval", () => {
  it("approve 是匹配调用的一次性授权，复检仍为 ask 时可以派发", async () => {
    const conversation = new Conversation("c1");
    const trace = {
      runId: "r1",
      step: 0,
      llmCallId: "l1",
      projectedThroughSeq: 1,
    };
    const call = {
      id: "t1",
      name: "write_file",
      args: { path: "a.txt", content: "hello" },
    };
    await conversation.emit({
      type: "tool_policy_mode_changed",
      source: "environment",
      mode: "default",
    });
    await conversation.emit({
      type: "agent_message",
      source: "agent",
      text: "",
      toolCalls: [call],
      executionTrace: trace,
    });
    const interactions = new HumanInteractionCoordinator();
    const request = await interactions.requestApproval(conversation, {
      toolCallId: call.id,
      reason: "ask",
      continuation: trace,
    });
    await interactions.respond(conversation, request.interactionId, {
      interactionType: "approval",
      response: { decision: "approve" },
    });

    const execute = vi.fn(async () => ({ content: "ok", isError: false }));
    const tool: Tool<{ path: string; content: string }> = {
      name: "write_file",
      description: "test",
      schema: z.object({ path: z.string(), content: z.string() }),
      execute,
    };
    const store = new MemoryRunLogStore();
    const journal = await RunJournal.open("c1", store);
    const executor = new ToolCallExecutor(
      new ToolRegistry().register(tool),
      journal,
      interactions
    );
    await expect(executor.executeCalls(
      conversation,
      [call],
      { runtime: {} as never },
      trace
    )).resolves.toEqual({ type: "completed" });

    expect(execute).toHaveBeenCalledOnce();
    expect(conversation.getEvents().slice(-2).map((event) => event.type)).toEqual([
      "tool_call_dispatched",
      "tool_result",
    ]);
  });
});
