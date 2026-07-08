import { describe, it, expect } from "vitest";
import { ToolRegistry } from "./tool.js";
import { optionalToolCatalog, listOptionalToolNames } from "./catalog.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { finishTool } from "./finish.js";

describe("optionalToolCatalog", () => {
  it("包含 run_bash / run_code / browser 三个可选工具", () => {
    expect(optionalToolCatalog.has("run_bash")).toBe(true);
    expect(optionalToolCatalog.has("run_code")).toBe(true);
    expect(optionalToolCatalog.has("browser")).toBe(true);
    expect(optionalToolCatalog.size).toBe(3);
  });

  it("每个工具的 name 与 key 一致", () => {
    for (const [key, tool] of optionalToolCatalog) {
      expect(tool.name).toBe(key);
    }
  });
});

describe("listOptionalToolNames", () => {
  it("返回所有可选工具名", () => {
    const names = listOptionalToolNames();
    expect(names).toContain("run_bash");
    expect(names).toContain("run_code");
    expect(names).toContain("browser");
    expect(names).toHaveLength(3);
  });
});

describe("ToolRegistry 动态组装", () => {
  it("必选工具始终可注册", () => {
    const registry = new ToolRegistry()
      .register(readFileTool)
      .register(writeFileTool)
      .register(finishTool);

    expect(registry.get("read_file")).toBe(readFileTool);
    expect(registry.get("write_file")).toBe(writeFileTool);
    expect(registry.get("finish")).toBe(finishTool);
    expect(registry.list()).toHaveLength(3);
  });

  it("按名追加可选工具", () => {
    const registry = new ToolRegistry()
      .register(readFileTool)
      .register(writeFileTool)
      .register(finishTool);

    const toolNames = ["run_bash", "run_code"];
    for (const name of toolNames) {
      const tool = optionalToolCatalog.get(name);
      expect(tool).toBeDefined();
      registry.register(tool!);
    }

    expect(registry.list()).toHaveLength(5);
    expect(registry.get("run_bash")).toBeDefined();
    expect(registry.get("run_code")).toBeDefined();
    // browser 未注册
    expect(registry.get("browser")).toBeUndefined();
  });

  it("未知工具名在 catalog 中查不到", () => {
    expect(optionalToolCatalog.get("nonexistent")).toBeUndefined();
  });

  it("重名注册抛错", () => {
    const registry = new ToolRegistry().register(readFileTool);
    expect(() => registry.register(readFileTool)).toThrow("工具重名");
  });

  it("空 tools 列表只有必选工具", () => {
    const registry = new ToolRegistry()
      .register(readFileTool)
      .register(writeFileTool)
      .register(finishTool);
    // 不追加任何可选工具
    expect(registry.list()).toHaveLength(3);
    expect(registry.get("run_bash")).toBeUndefined();
  });
});
