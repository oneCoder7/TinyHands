import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FsConversationStore } from "../../conversation/conversation-store.js";
import type { LLMClient } from "../../llm/llm-client.js";
import type { LLMResponse } from "../../llm/types.js";
import { FsRunLogStore } from "../../observability/run-log-store.js";
import { Conversation } from "../../conversation/conversation.js";
import type { Runtime } from "../../runtime/runtime.js";
import {
  AgentSession,
  makeAgentSessionFactory,
} from "../agent-session.js";
import { HumanInteractionCoordinator } from "../human-interaction.js";

describe("AgentSession 执行关联", () => {
  it("独占 Runtime 生命周期，并通过显式 run context 交给 Agent", async () => {
    const runtime = {
      start: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    } as unknown as Runtime;
    const run = vi.fn(
      async (
        conversation: Conversation,
        context: { runId: string; runtime: Runtime; signal?: AbortSignal }
      ) => {
        expect(context.runtime).toBe(runtime);
        return {
          status: "completed" as const,
          lastText: "",
          trajectory: conversation.getEvents(),
          projectedThroughSeq: conversation.getEvents().at(-1)?.seq ?? 0,
        };
      }
    );
    const session = new AgentSession({
      conversationId: "owned",
      conversation: new Conversation("owned"),
      runtime,
      agent: { run } as never,
      journal: {
        append: vi.fn(async () => {}),
        recoverOpenRuns: vi.fn(async () => {}),
      } as never,
      conversationCreatedAt: Date.now(),
    });

    expect("runtime" in session.conversation).toBe(false);
    await session.submit("first");
    await vi.waitFor(() => expect(session.running).toBe(false));
    await session.submit("second");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(session.running).toBe(false));
    await Promise.all([session.close(), session.close()]);

    expect(runtime.start).toHaveBeenCalledTimes(1);
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it("submit 返回并持久化 triggerId，Run Log 闭合到 run_completed", async () => {
    const root = mkdtempSync(join(tmpdir(), "tinyhands-agent-session-test-"));
    const conversationStore = new FsConversationStore(root);
    const runLogStore = new FsRunLogStore(root);
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat: vi.fn(async (): Promise<LLMResponse> => ({
        stopReason: "tool_call",
        text: "",
        toolCalls: [
          { id: "finish-1", name: "finish", args: { result: "done" } },
        ],
        usage: {
          status: "reported",
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        },
      })),
    };
    const createSession = makeAgentSessionFactory({
      llm,
      maxStep: 2,
      runtime: { type: "local" },
      conversationStore,
      runLogStore,
    });
    const session = await createSession({
      conversationId: "c1",
      workspaceDir: join(root, "c1"),
      tools: [],
    });

    const submitted = await session.submit("hello");
    const deadline = Date.now() + 2_000;
    while (session.running && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }

    expect(session.running).toBe(false);
    const userEvent = session.conversation
      .getEvents()
      .find((event) => event.type === "user_message");
    expect(userEvent).toMatchObject({
      seq: submitted.userMessageSeq,
      triggerId: submitted.triggerId,
    });

    const records = await runLogStore.loadAndRepair("c1");
    expect(records.map((record) => record.type)).toEqual([
      "run_started",
      "step_started",
      "llm_started",
      "llm_completed",
      "llm_disposition",
      "tool_call_dispatched",
      "tool_call_completed",
      "step_completed",
      "run_completed",
    ]);
    expect(records.find((record) => record.type === "step_started")).toMatchObject({
      triggerIds: [submitted.triggerId],
    });
    expect(records.at(-1)).toMatchObject({
      type: "run_completed",
      status: "completed",
    });
  });

  it("interrupt 后旧 run 退出前到达的新 query 会立即启动新 run", async () => {
    const root = mkdtempSync(join(tmpdir(), "tinyhands-agent-session-test-"));
    const conversationStore = new FsConversationStore(root);
    const runLogStore = new FsRunLogStore(root);
    let rejectFirst: ((error: Error) => void) | undefined;
    const chat = vi
      .fn<LLMClient["chat"]>()
      .mockImplementationOnce(
        async (_messages, _tools, options) =>
          await new Promise<LLMResponse>((_resolve, reject) => {
            rejectFirst = reject;
            options?.signal?.addEventListener("abort", () => {}, { once: true });
          })
      )
      .mockImplementationOnce(async () => ({
        stopReason: "tool_call",
        text: "",
        toolCalls: [
          { id: "finish-2", name: "finish", args: { result: "second done" } },
        ],
        usage: {
          status: "reported",
          usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        },
      }));
    const llm: LLMClient = {
      identity: { provider: "test", model: "model-1", apiMode: "messages" },
      chat,
    };
    const createSession = makeAgentSessionFactory({
      llm,
      maxStep: 2,
      runtime: { type: "local" },
      conversationStore,
      runLogStore,
    });
    const session = await createSession({
      conversationId: "c2",
      workspaceDir: join(root, "c2"),
      tools: [],
    });

    await session.submit("first");
    await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    expect(await session.interrupt()).toBe(true);
    const second = await session.submit("second");
    expect(session.running).toBe(true);
    rejectFirst?.(new Error("aborted"));

    await vi.waitFor(() => expect(session.running).toBe(false));
    expect(chat).toHaveBeenCalledTimes(2);
    expect(
      session.conversation
        .getEvents()
        .find((event) => event.seq === second.userMessageSeq)
    ).toMatchObject({ type: "user_message", text: "second" });
    expect(session.conversation.getEvents().at(-1)).toMatchObject({
      type: "agent_completed",
      result: "second done",
    });
    const completedRuns = (await runLogStore.loadAndRepair("c2")).filter(
      (record) => record.type === "run_completed"
    );
    expect(completedRuns).toHaveLength(2);
    expect(completedRuns[0]).toMatchObject({ status: "interrupted" });
    expect(completedRuns[1]).toMatchObject({ status: "completed" });
  });

  it("审批拒绝后配对 tool_result，并从原 run/step 继续", async () => {
    const root = mkdtempSync(join(tmpdir(), "tinyhands-approval-test-"));
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
          args: { path: "blocked.txt", content: "x" },
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
    const createSession = makeAgentSessionFactory({
      llm: {
        identity: { provider: "test", model: "model", apiMode: "messages" },
        chat,
      },
      maxStep: 3,
      runtime: { type: "local" },
      conversationStore,
      runLogStore,
    });
    const session = await createSession({
      conversationId: "approval",
      workspaceDir: join(root, "approval"),
      tools: [],
    });
    await session.conversation.emit({
      type: "tool_policy_mode_changed",
      source: "environment",
      mode: "default",
    });

    await session.submit("go");
    await vi.waitFor(() => expect(session.waitingForInteraction).toBe(true));
    await expect(session.submit("must not persist")).rejects.toThrow(
      "等待 human interaction"
    );
    expect(session.conversation.getEvents().filter(
      (event) => event.type === "user_message"
    )).toHaveLength(1);
    const request = session.conversation
      .getEvents()
      .find((event) => event.type === "human_interaction_requested");
    if (!request || request.type !== "human_interaction_requested") {
      throw new Error("missing interaction");
    }
    await new HumanInteractionCoordinator().respond(
      session.conversation,
      request.interactionId,
      {
        interactionType: "approval",
        response: { decision: "reject", reason: "not now" },
      }
    );
    await session.resumeInteraction(request);
    await vi.waitFor(() => expect(session.running).toBe(false));

    expect(chat).toHaveBeenCalledTimes(2);
    expect(session.conversation.getEvents().find(
      (event) => event.type === "tool_result" && event.toolCallId === "write-1"
    )).toMatchObject({ isError: true, content: "工具调用未获批准：not now" });
    expect(session.conversation.getEvents().at(-1)).toMatchObject({
      type: "agent_completed",
      result: "done",
    });
    expect((await runLogStore.loadAndRepair("approval")).filter(
      (record) => record.type === "run_started"
    )).toHaveLength(1);
  });
});
