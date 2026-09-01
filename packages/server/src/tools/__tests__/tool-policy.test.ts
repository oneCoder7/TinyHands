import { describe, expect, it, vi } from "vitest";
import { evaluateToolPolicy } from "../tool-policy.js";

describe("Tool Policy", () => {
  it("getter 收到由工具 schema 校验后的判别联合参数", async () => {
    const getter = vi.fn(async (query) => {
      if (query.toolName === "write_file") {
        expect(query.args).toEqual({ path: "a.txt", content: "hello" });
      }
      return { type: "allow" as const };
    });
    await expect(evaluateToolPolicy({
      conversationId: "c1",
      mode: "request_approval",
      getter,
      toolName: "write_file",
      args: { path: "a.txt", content: "hello" },
    })).resolves.toEqual({ source: "getter", decision: { type: "allow" } });
    expect(getter).toHaveBeenCalledOnce();
  });

  it("default 只直接允许 read_file，full_access 兼容自定义工具", async () => {
    await expect(evaluateToolPolicy({
      conversationId: "c1", mode: "default", toolName: "read_file",
      args: { path: "a.txt" },
    })).resolves.toMatchObject({ decision: { type: "allow" } });
    await expect(evaluateToolPolicy({
      conversationId: "c1", mode: "default", toolName: "write_file",
      args: { path: "a.txt", content: "x" },
    })).resolves.toMatchObject({ decision: { type: "ask" } });
    await expect(evaluateToolPolicy({
      conversationId: "c1", mode: "full_access", toolName: "custom_tool", args: {},
    })).resolves.toEqual({ source: "mode", decision: { type: "allow" } });
  });

  it("getter 异常 fail closed", async () => {
    const result = await evaluateToolPolicy({
      conversationId: "c1",
      mode: "full_access",
      getter: async () => { throw new Error("business store down"); },
      toolName: "read_file",
      args: { path: "a.txt" },
    });
    expect(result).toMatchObject({ source: "getter_error", decision: { type: "deny" } });
  });
});
