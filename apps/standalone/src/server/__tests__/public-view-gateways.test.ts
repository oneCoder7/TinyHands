import { get } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Conversation } from "../../../../../packages/server/src/conversation/conversation.js";
import { FsConversationStore } from "../../../../../packages/server/src/conversation/conversation-store.js";
import type { ProviderReplayState } from "../../../../../packages/server/src/llm/types.js";
import type { Runtime } from "../../../../../packages/server/src/runtime/runtime.js";
import type { ConversationService } from "@tinyhands/server";
import { DefaultConversationService } from "../../../../../packages/server/src/server/conversation-service.js";
import { registerSseGateway } from "../sse-gateway.js";
import { registerWsGateway } from "../ws-gateway.js";
import { AgentSession } from "../../../../../packages/server/src/server/agent-session.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function replay(secret: string): ProviderReplayState {
  return {
    kind: "openai_responses",
    version: 1,
    scope: {
      provider: "openai",
      apiMode: "responses",
      model: "gpt-test",
      endpointHash: "hash",
    },
    items: [
      {
        type: "reasoning",
        id: "rs-1",
        summary: [],
        encryptedContent: secret,
      },
    ],
  };
}

async function serviceFor(conversation: Conversation): Promise<ConversationService> {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "tinyhands-gateway-test-"));
  const conversationStore = new FsConversationStore(workspaceRoot);
  const service = new DefaultConversationService({
    workspaceRoot,
    conversationStore,
    createSession: async ({ conversationId }) => new AgentSession({
      conversationId,
      conversation,
      agent: {} as never,
      journal: {} as never,
      runtime: { kill: async () => {} } as Runtime,
      conversationCreatedAt: Date.now(),
    }),
  });
  await service.create({ conversationId: conversation.id });
  return service;
}

async function emitCheckpoint(
  conversation: Conversation,
  compactionId: string
): Promise<void> {
  await conversation.emit({
    type: "compacted",
    source: "agent",
    compactionId,
    throughSeq: 0,
    summaryVersion: 1,
    summary: {
      objective: "internal-secret-summary",
      confirmedDecisions: [],
      constraints: [],
      completedWork: [],
      currentState: [],
      importantArtifacts: [],
      unresolvedIssues: [],
      nextActions: [],
    },
    provider: "test",
    model: "model",
    estimatedBeforeTokens: 100,
    estimatedAfterTokens: 40,
  });
}

function address(app: ReturnType<typeof Fastify>): { host: string; port: number } {
  const value = app.server.address();
  if (!value || typeof value === "string") throw new Error("server address missing");
  return { host: "127.0.0.1", port: value.port };
}

describe("WS/SSE Public Event View", () => {
  it("WS 首连历史与实时事件都不包含 providerReplay", async () => {
    const conversation = new Conversation("c1");
    await emitCheckpoint(conversation, "historical-cmp");
    await conversation.emit({
      type: "agent_message",
      source: "agent",
      text: "historical",
      toolCalls: [],
      providerReplay: replay("historical-ciphertext"),
    });

    const app = Fastify();
    apps.push(app);
    await app.register(websocket);
    registerWsGateway(app, await serviceFor(conversation));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { host, port } = address(app);
    const ws = new WebSocket(`ws://${host}:${port}/ws/c1`);

    const first = await nextWsMessage(ws);
    expect(first).toContain("historical");
    expect(first).not.toContain("providerReplay");
    expect(first).not.toContain("historical-ciphertext");

    const secondPromise = nextWsMessage(ws);
    await emitCheckpoint(conversation, "realtime-cmp");
    await conversation.emit({
      type: "agent_message",
      source: "agent",
      text: "realtime",
      toolCalls: [],
      providerReplay: replay("realtime-ciphertext"),
    });
    const second = await secondPromise;
    expect(second).toContain("realtime");
    expect(second).not.toContain("providerReplay");
    expect(second).not.toContain("realtime-ciphertext");
    expect(first + second).not.toContain("internal-secret-summary");
    ws.close();
  });

  it("SSE 首连历史不包含 providerReplay", async () => {
    const conversation = new Conversation("c1");
    await emitCheckpoint(conversation, "sse-cmp");
    await conversation.emit({
      type: "agent_message",
      source: "agent",
      text: "sse-historical",
      toolCalls: [],
      providerReplay: replay("sse-ciphertext"),
    });

    const app = Fastify();
    apps.push(app);
    registerSseGateway(app, await serviceFor(conversation));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { host, port } = address(app);

    const body = await readFirstSseEvent(`http://${host}:${port}/sse/c1`);
    expect(body).toContain("sse-historical");
    expect(body).not.toContain("providerReplay");
    expect(body).not.toContain("sse-ciphertext");
    expect(body).not.toContain("internal-secret-summary");
  });

  it("删除会话时 WS 根据 subscription closeReason 保持 4410 语义", async () => {
    const conversation = new Conversation("c1");
    const service = await serviceFor(conversation);
    const app = Fastify();
    apps.push(app);
    await app.register(websocket);
    registerWsGateway(app, service);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { host, port } = address(app);
    const ws = new WebSocket(`ws://${host}:${port}/ws/c1`);
    await once(ws, "open");

    const closed = once(ws, "close");
    await service.delete("c1");
    const [code, reason] = (await closed) as [number, Buffer];
    expect(code).toBe(4410);
    expect(reason.toString()).toBe("conversation destroyed");
  });

  it("删除会话时 SSE 根据 subscription closeReason 发送 legacy 错误并结束", async () => {
    const conversation = new Conversation("c1");
    const service = await serviceFor(conversation);
    const app = Fastify();
    apps.push(app);
    registerSseGateway(app, service);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { host, port } = address(app);

    const responsePromise = new Promise<import("node:http").IncomingMessage>(
      (resolve, reject) => {
        const req = get(`http://${host}:${port}/sse/c1`, resolve);
        req.on("error", reject);
      }
    );
    const response = await responsePromise;
    response.setEncoding("utf8");
    let body = "";
    response.on("data", (chunk: string) => {
      body += chunk;
    });
    const ended = once(response, "end");

    await service.delete("c1");
    await ended;
    expect(body).toContain('"protocolError":"conversation destroyed"');
  });
});

function nextWsMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data.toString()));
    ws.once("error", reject);
  });
}

function readFirstSseEvent(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (!body.includes("sse-historical")) return;
        res.once("close", () => resolve(body));
        res.destroy();
      });
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}
