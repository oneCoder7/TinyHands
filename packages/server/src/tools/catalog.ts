import type { Tool } from "./tool.js";
import { runBashTool } from "./run-bash.js";
import { runCodeTool } from "./run-code.js";
import { browserTool } from "./browser.js";

/**
 * 可选工具目录。工具分两层:
 *  - 必选(read_file / write_file / finish):每个 conversation 始终注册,由 session
 *    factory 直接写入 ToolRegistry,不经此目录。
 *  - 可选(run_bash / run_code / browser):创建 conversation 时从此目录按 tools[]
 *    查找并追加。新增可选工具只需在此 import 并加入 Map,其余零改动(开闭原则)。
 */
export const optionalToolCatalog = new Map<string, Tool>([
  ["run_bash", runBashTool],
  ["run_code", runCodeTool],
  ["browser", browserTool],
]);

/** 返回所有可选工具的名称列表(用于 API 校验/文档) */
export function listOptionalToolNames(): string[] {
  return [...optionalToolCatalog.keys()];
}
