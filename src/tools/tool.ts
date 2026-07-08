import { z } from "zod/v4";
import type { ToolOutput } from "../llm/types.js";
import type { Runtime } from "../runtime/runtime.js";

/**
 * 工具执行上下文 —— 「这次调用发生在哪个 runtime」的载体。
 *
 * runtime 每会话一个(多租户),工具全局注册一次,故 runtime 执行时传、而非构造时注入:
 * 每次执行由 Agent 把当前会话的 runtime 组进 ctx。
 */
export interface ToolContext {
  /** 本次调用所在会话的执行环境 */
  runtime: Runtime;
}

/**
 * 工具接口 —— 每个工具是一个对象,自带 name + schema + execute。Agent 循环只跟这个
 * 抽象打交道,新增工具 = 新增一个 implements Tool 的对象并注册,循环代码零改动。
 * 泛型 A = 该工具的参数类型,由 schema 推导。
 */
export interface Tool<A = any> {
  /** 工具名,LLM 用它来指定调用谁 */
  name: string;
  /** 给 LLM 看的说明,影响它何时选择这个工具 */
  description: string;
  /**
   * 参数的 Zod schema,一物两用:① execute 前 schema.parse(args) 运行时校验;
   * ② 转成 JSON Schema 作为给 LLM 的工具入参定义(AnthropicClient 内部转换)。
   */
  schema: z.ZodType<A>;
  /**
   * 真正干活的地方。返回裸结果,由 Agent 补 toolCallId。通过 ctx.runtime 执行 ——
   * 工具只表达意图,不关心执行位置。
   */
  execute(args: A, ctx: ToolContext): Promise<ToolOutput>;
}

/** 工具注册表 —— 循环只跟它打交道:按名字查工具、列出全部工具(传给 LLM)。 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`工具重名：${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }
}
