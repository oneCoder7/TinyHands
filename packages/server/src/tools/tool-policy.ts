import type { ToolPolicyMode } from "@tinyhands/protocol";
import {
  BrowserArgsSchema,
  type BrowserArgs,
} from "./browser.js";
import {
  ReadFileArgsSchema,
  type ReadFileArgs,
} from "./read-file.js";
import {
  RunBashArgsSchema,
  type RunBashArgs,
} from "./run-bash.js";
import {
  RunCodeArgsSchema,
  type RunCodeArgs,
} from "./run-code.js";
import {
  WriteFileArgsSchema,
  type WriteFileArgs,
} from "./write-file.js";

export interface ToolPolicyArgsMap {
  read_file: ReadFileArgs;
  write_file: WriteFileArgs;
  run_bash: RunBashArgs;
  run_code: RunCodeArgs;
  browser: BrowserArgs;
}

export type ToolPolicyName = keyof ToolPolicyArgsMap;

export type ToolPolicyQuery = {
  [K in ToolPolicyName]: {
    conversationId: string;
    toolName: K;
    args: Readonly<ToolPolicyArgsMap[K]>;
  };
}[ToolPolicyName];

export type ToolPolicyDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string }
  | { type: "ask"; reason: string };

export type ToolPolicyGetter = (
  query: ToolPolicyQuery
) =>
  | ToolPolicyDecision
  | undefined
  | Promise<ToolPolicyDecision | undefined>;

export interface ToolPolicyConfig {
  /** 新 Conversation 创建时的一次性默认值；省略为 default。 */
  defaultMode?: ToolPolicyMode;
  /** 每次已知且参数合法的 ToolCall 都动态调用，返回 undefined 才走 mode fallback。 */
  getter?: ToolPolicyGetter;
}

export interface ToolPolicyEvaluation {
  decision: ToolPolicyDecision;
  source: "getter" | "mode" | "getter_error";
}

export async function evaluateToolPolicy(input: {
  conversationId: string;
  mode: ToolPolicyMode;
  getter?: ToolPolicyGetter;
  toolName: string;
  args: unknown;
}): Promise<ToolPolicyEvaluation> {
  // full_access 不需要业务按工具解释参数，也兼容 Host 注册的自定义工具。
  if (input.mode === "full_access" && !input.getter) {
    return { source: "mode", decision: { type: "allow" } };
  }
  const query = createToolPolicyQuery(
    input.conversationId,
    input.toolName,
    input.args
  );
  if (!query) {
    return {
      source: "getter_error",
      decision: {
        type: "deny",
        reason: `工具 ${input.toolName} 没有可用的权限类型定义`,
      },
    };
  }

  if (input.getter) {
    try {
      const decision = await input.getter(query);
      if (decision !== undefined) {
        if (!isToolPolicyDecision(decision)) {
          return invalidGetterDecision();
        }
        return { source: "getter", decision };
      }
    } catch {
      return invalidGetterDecision();
    }
  }

  return { source: "mode", decision: fallbackDecision(input.mode, query.toolName) };
}

export function isToolPolicyName(value: string): value is ToolPolicyName {
  return (
    value === "read_file" ||
    value === "write_file" ||
    value === "run_bash" ||
    value === "run_code" ||
    value === "browser"
  );
}

function createToolPolicyQuery(
  conversationId: string,
  toolName: string,
  args: unknown
): ToolPolicyQuery | undefined {
  switch (toolName) {
    case "read_file":
      return { conversationId, toolName, args: ReadFileArgsSchema.parse(args) };
    case "write_file":
      return { conversationId, toolName, args: WriteFileArgsSchema.parse(args) };
    case "run_bash":
      return { conversationId, toolName, args: RunBashArgsSchema.parse(args) };
    case "run_code":
      return { conversationId, toolName, args: RunCodeArgsSchema.parse(args) };
    case "browser":
      return { conversationId, toolName, args: BrowserArgsSchema.parse(args) };
    default:
      return undefined;
  }
}

function fallbackDecision(
  mode: ToolPolicyMode,
  toolName: ToolPolicyName
): ToolPolicyDecision {
  if (mode === "full_access") return { type: "allow" };
  if (mode === "default" && toolName === "read_file") {
    return { type: "allow" };
  }
  return {
    type: "ask",
    reason:
      mode === "request_approval"
        ? "当前 Conversation 要求所有工具调用获得批准"
        : `默认策略要求批准工具 ${toolName}`,
  };
}

function invalidGetterDecision(): ToolPolicyEvaluation {
  return {
    source: "getter_error",
    decision: {
      type: "deny",
      reason: "业务工具策略检查失败，已拒绝当前调用",
    },
  };
}

function isToolPolicyDecision(value: unknown): value is ToolPolicyDecision {
  if (!value || typeof value !== "object") return false;
  const decision = value as Record<string, unknown>;
  if (decision.type === "allow") return true;
  return (
    (decision.type === "deny" || decision.type === "ask") &&
    typeof decision.reason === "string" &&
    decision.reason.length > 0
  );
}
