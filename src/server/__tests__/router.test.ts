import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { registerRoutes } from "../router.js";
import { ConversationManager } from "../conversation-manager.js";
import type { SessionFactory } from "../agent-session.js";
import { FsEventStore } from "../../conversation/event-store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * router 测试 —— 用 Fastify inject() 做 HTTP 级测试。
 *
 * Mock SessionFactory:避免真创建 Runtime(Docker/Local),
 * 只验证 router → manager → factory 的参数传递和校验逻辑。
 */

/** 构造一个最小可用的测试 Fastify 实例 + mock manager */
async function buildApp(factoryOverride?: SessionFactory) {
  const factory: SessionFactory =
    factoryOverride ??
    (async ({ conversationId, workspaceDir, tools }) => ({
      conversationId,
      conversation: {
        runtime: {} as any,
        emit: async () => ({} as any),
        emitDelta: () => {},
        subscribe: () => {},
        getEvents: () => [],
        getEventsSince: () => [],
      } as any,
      agent: {} as any,
      workspaceDir,
      createdAt: Date.now(),
      running: false,
      runAbort: null,
      runtimeStarted: false,
    }));

  const app = Fastify();

  // 空 body → {}(与 server.ts 中的 parser 行为一致)
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const text = typeof body === "string" ? body.trim() : "";
      if (!text) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    }
  );

  // 每个测试用独立的 tmp 目录,避免 list/恢复互相串扰
  const workspaceRoot = mkdtempSync(join(tmpdir(), "tinyhands-router-test-"));
  const manager = new ConversationManager({
    workspaceRoot,
    createSession: factory,
    eventStore: new FsEventStore(workspaceRoot),
  });

  registerRoutes(app, manager, () => 0);

  return { app, manager };
}

describe("POST /conversations/create — tools 字段", () => {
  it("不传 tools:默认行为(向后兼容),201 成功", async () => {
    const { app } = await buildApp();
    const resp = await app.inject({
      method: "POST",
      url: "/conversations/create",
      payload: {},
    });
    expect(resp.statusCode).toBe(201);
    const body = resp.json();
    expect(body.conversationId).toBeDefined();
  });

  it("传合法 tools:201 成功", async () => {
    const { app } = await buildApp();
    const resp = await app.inject({
      method: "POST",
      url: "/conversations/create",
      payload: { tools: ["run_bash", "run_code"] },
    });
    expect(resp.statusCode).toBe(201);
  });

  it("传空数组 tools=[]:201 成功(只有必选工具)", async () => {
    const { app } = await buildApp();
    const resp = await app.inject({
      method: "POST",
      url: "/conversations/create",
      payload: { tools: [] },
    });
    expect(resp.statusCode).toBe(201);
  });

  it("传全部可选工具:201 成功", async () => {
    const { app } = await buildApp();
    const resp = await app.inject({
      method: "POST",
      url: "/conversations/create",
      payload: { tools: ["run_bash", "run_code", "browser"] },
    });
    expect(resp.statusCode).toBe(201);
  });

  it("传未知工具名:400 + 错误信息包含可用工具列表", async () => {
    const { app } = await buildApp();
    const resp = await app.inject({
      method: "POST",
      url: "/conversations/create",
      payload: { tools: ["run_bash", "magic_tool"] },
    });
    expect(resp.statusCode).toBe(400);
    const body = resp.json();
    expect(body.error).toContain("magic_tool");
    expect(body.error).toContain("run_bash");
    expect(body.error).toContain("run_code");
    expect(body.error).toContain("browser");
  });

  it("tools 透传到 SessionFactory", async () => {
    let capturedTools: string[] | undefined;
    const factory: SessionFactory = async ({ conversationId, workspaceDir, tools }) => {
      capturedTools = tools;
      return {
        conversationId,
        conversation: {
          runtime: {} as any,
          emit: async () => ({} as any),
          emitDelta: () => {},
          subscribe: () => {},
          getEvents: () => [],
          getEventsSince: () => [],
        } as any,
        agent: {} as any,
        workspaceDir,
        createdAt: Date.now(),
        running: false,
        runAbort: null,
        runtimeStarted: false,
      };
    };

    const { app } = await buildApp(factory);
    await app.inject({
      method: "POST",
      url: "/conversations/create",
      payload: { tools: ["run_code", "browser"] },
    });
    expect(capturedTools).toEqual(["run_code", "browser"]);
  });
});
