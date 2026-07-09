import type { LLMClient } from "../llm/llm-client.js";
import type { LLMResponse, ToolResult } from "../llm/types.js";
import type { ToolRegistry, ToolContext } from "../tools/tool.js";
import type { Conversation } from "../conversation/conversation.js";
import { projectToMessages, type Event } from "../conversation/events.js";

export type RunStatus =
  | "completed"
  | "max_steps_exceeded"
  | "error"
  | "interrupted";

export interface RunResult {
  status: RunStatus;
  /** finish 的结构化结果（completed 时有） */
  result?: string;
  /** 最后一轮的文字（兜底展示） */
  lastText: string;
  /** 完整可审计轨迹 —— 由事件流提供(事件是真相源) */
  trajectory: Event[];
  /** error 时的原因 */
  error?: string;
  /**
   * 本次 run 最后一次投影覆盖到的事件 seq —— lost-wakeup 水位线。
   * driveRun 用它判断 run 结束后是否还有本次 run 从未见过的 user_message,有则重跑。
   */
  projectedThroughSeq: number;
}

export interface AgentOptions {
  maxStep?: number;
}

/**
 * Agent —— ReAct 循环的心脏。
 *
 * 只依赖 LLMClient 和 ToolRegistry 两个抽象(依赖倒置)。不直接拼 Message,而是
 * emit 事件:事件流是真相源,喂 LLM 的 Message[] 由事件流投影得到;emit 同步触发
 * 订阅者实现「边跑边推进度」。
 *
 * 打断(协作式):调用方传 opts.signal(AbortSignal)。run 在三个检查点识别
 * signal.aborted 并以 status:"interrupted" 正常返回(打断不是错误,不 emit error):
 *   ① 步首(投影前,无补偿)
 *   ② LLM 期间/刚返回(整轮丢弃 —— 此刻本轮零持久事件入流)
 *   ③ 工具之间(给剩余未执行的 tool_use 补 isError 配对,保投影合法)
 * 识别只看 signal.aborted,不 import 任何 SDK 错误类型。
 */
export class Agent {
  private llm: LLMClient;
  private tools: ToolRegistry;
  private maxStep: number;

  constructor(llm: LLMClient, tools: ToolRegistry, opts: AgentOptions = {}) {
    this.llm = llm;
    this.tools = tools;
    this.maxStep = opts.maxStep ?? 10;
  }

  async run(
    conversation: Conversation,
    opts: { signal?: AbortSignal } = {}
  ): Promise<RunResult> {
    const signal = opts.signal;
    let lastText = "";
    // lost-wakeup 水位线：本 run 最后一次投影覆盖到的最大 seq(见 RunResult 注释)
    let projectedThroughSeq = 0;
    // 本次运行的工具执行上下文：绑定当前会话的 runtime，传给每次 tool.execute。
    const ctx: ToolContext = { runtime: conversation.runtime };

    // 打断收尾统一在此：读 lastText/projectedThroughSeq 的【当前】值
    const interruptedResult = (): RunResult => ({
      status: "interrupted",
      lastText,
      trajectory: conversation.getEvents(),
      projectedThroughSeq,
    });

    for (let step = 0; step < this.maxStep; step++) {
      // —— 检查点①：步首。上一步配对已闭合，无需补偿，直接终结。
      if (signal?.aborted) return interruptedResult();

      // 每轮把事件流投影成 Message[] 喂给 LLM。取同一份事件快照做投影 + 记水位线,
      // 保证「水位线 = 本次投影真正覆盖的范围」。
      const events = conversation.getEvents();
      projectedThroughSeq = events.at(-1)?.seq ?? 0;
      const messages = projectToMessages(events);

      // 传 onDelta,把流式 Delta 转发给 conversation 广播(只广播不入库),与随后
      // emit 的 Event 走同一时间线。signal 正向透传:abort 时 SDK 中止底层请求。
      let resp: LLMResponse;
      try {
        resp = await this.llm.chat(messages, this.tools.list(), {
          onDelta: (d) => conversation.emitDelta(d),
          signal,
        });
      } catch (err) {
        // —— 检查点②(a)：打断中止了 LLM 请求。此刻本轮零持久事件入流，
        //    整轮丢弃(已流出的 Delta 是瞬态、本就不入库)。
        if (signal?.aborted) return interruptedResult();
        throw err; // 非打断的真异常，交上层兜底
      }
      // 检查点②(b):chat 正常返回但打断已请求(竞态:流恰好先跑完)。必须在
      // thinking_finished emit 之前 —— 晚了事件流会残留孤立思考块,投影产出半截
      // assistant 消息,「整轮丢弃」就不成立。
      if (signal?.aborted) return interruptedResult();

      lastText = resp.text;

      // 思考定稿入库(必须在 agent_message 之前 emit,投影才能把它折叠进同一条
      // assistant message 且 thinking 在前;否则多轮回传 400)。
      if (resp.thinkingBlocks?.length) {
        await conversation.emit({
          type: "thinking_finished",
          source: "agent",
          blocks: resp.thinkingBlocks,
        });
      }

      // —— 分支 3:max_tokens(这轮被截断,结果不可信),不做 continuation,直接返回 error
      if (resp.stopReason === "max_tokens") {
        await conversation.emit({
          type: "error",
          source: "agent",
          message: "LLM 输出被截断(max_tokens)，本轮结果不可信",
        });
        return {
          status: "error",
          lastText,
          trajectory: conversation.getEvents(),
          error: "LLM 输出被截断(max_tokens)，本轮结果不可信",
          projectedThroughSeq,
        };
      }

      // —— 分支 4:end_turn 纯文字(没调任何工具)。finish 流派里这是异常:该收尾
      //    却光说话不动手。怼一句给两条出路,继续循环(靠 max_step 兜底防死循环)
      if (resp.toolCalls.length === 0) {
        // 先记这轮文字(空文字也记,保留轨迹;投影时跳过空 assistant)
        await conversation.emit({
          type: "agent_message",
          source: "agent",
          text: resp.text,
          toolCalls: [],
        });
        // 再 emit 一条 user 提示，给两条明确出路
        await conversation.emit({
          type: "user_message",
          source: "user",
          text:
            "如果任务已经完成，请调用 finish 工具给出最终答复；" +
            "如果还需要继续操作，请发起相应的工具调用。",
        });
        continue;
      }

      // —— 有工具调用：先把 assistant 这轮（含 text + toolCalls）整体记进事件流
      await conversation.emit({
        type: "agent_message",
        source: "agent",
        text: resp.text,
        toolCalls: resp.toolCalls,
      });

      // —— 分支 1：检查是否有 finish 调用（优先于其他工具）
      const finishCall = resp.toolCalls.find((tc) => tc.name === "finish");
      if (finishCall) {
        // 复用 executeToolCall：同样有 schema 校验的 try/catch 保护
        const result = await this.executeToolCall(finishCall, ctx);

        // 无论成败,先给 finish 的 tool_use 配一条 tool_result。完成语义由独立的
        // finished 事件承载,但 tool_use↔tool_result 配对是 Anthropic 硬约束:
        // 下一次 run 会重投影整条流,缺配对 → 孤儿 → 400。
        await conversation.emit({
          type: "tool_result",
          source: "environment",
          toolCallId: result.toolCallId,
          content: result.content,
          isError: result.isError,
        });

        // 本轮若 finish 与其他工具同时被调,其余工具不执行,但也要各配一条 tool_result,
        // 否则它们的 tool_use 同样成孤儿。给明确说明,isError 标记未执行。
        for (const tc of resp.toolCalls) {
          if (tc.id === finishCall.id) continue;
          await conversation.emit({
            type: "tool_result",
            source: "environment",
            toolCallId: tc.id,
            content: "finish 已在本轮调用，该工具未执行",
            isError: true,
          });
        }

        // finish 参数校验失败 → 不算完成,怼回去让它重来(配对已在上面补齐,可安全 continue)
        if (result.isError) {
          await conversation.emit({
            type: "user_message",
            source: "user",
            text: "finish 调用的参数有误，请检查后重新调用 finish 工具。",
          });
          continue;
        }

        // finish 成功 → emit finished 承载完成语义,随后 return 收尾
        await conversation.emit({
          type: "finished",
          source: "agent",
          result: result.content,
        });
        return {
          status: "completed",
          result: result.content,
          lastText,
          trajectory: conversation.getEvents(),
          projectedThroughSeq,
        };
      }

      // —— 分支 2:其他工具调用,串行逐个执行(工具副作用无法静态分析,串行保证顺序)
      for (const [i, tc] of resp.toolCalls.entries()) {
        // —— 检查点③:工具之间(上一个工具 await 期间可能被打断)。给剩余未执行的
        //    tool_use 各补一条 isError 配对 —— 否则孤儿 tool_use 重投影必 400。补偿
        //    进 LLM 上下文,让下一轮知道哪些动作没执行。不杀进行中的工具:abort 只在
        //    工具自然结束后的这里生效。
        if (signal?.aborted) {
          for (const rest of resp.toolCalls.slice(i)) {
            await conversation.emit({
              type: "tool_result",
              source: "environment",
              toolCallId: rest.id,
              content: "用户已打断，该工具未执行",
              isError: true,
            });
          }
          return interruptedResult();
        }
        const result = await this.executeToolCall(tc, ctx);
        await conversation.emit({
          type: "tool_result",
          source: "environment",
          toolCallId: result.toolCallId,
          content: result.content,
          isError: result.isError,
        });
      }
      // 继续下一轮
    }

    // —— 检查点①':循环退出后。打断若恰落在【最后一步的最后一个工具】执行期间,
    //    ③与①都不再执行,唯有此处能接住 —— 否则打断会被误报成 max_steps_exceeded
    //    并 emit error,违背「打断不是错误」。此刻本步配对已全部闭合,直接终结安全。
    if (signal?.aborted) return interruptedResult();

    // —— 撞 max_step 兜底
    await conversation.emit({
      type: "error",
      source: "agent",
      message: `达到最大步数 ${this.maxStep}，任务未显式完成`,
    });
    return {
      status: "max_steps_exceeded",
      lastText,
      trajectory: conversation.getEvents(),
      error: `达到最大步数 ${this.maxStep}，任务未显式完成`,
      projectedThroughSeq,
    };
  }

  /** 执行单个工具调用，返回按 id 配对好的 ToolResult */
  private async executeToolCall(
    tc: {
      id: string;
      name: string;
      args: Record<string, unknown>;
    },
    ctx: ToolContext
  ): Promise<ToolResult> {
    const tool = this.tools.get(tc.name);
    if (!tool) {
      // 模型调了不存在的工具：把错误当观察喂回去，让它换别的
      return {
        toolCallId: tc.id,
        content: `未知工具：${tc.name}`,
        isError: true,
      };
    }
    try {
      // schema 校验 + 执行；execute 返回裸结果，这里补上配对 id（方案甲）
      // 把 ctx(含会话 runtime) 传给工具，工具经 ctx.runtime 执行。
      const parsed = tool.schema.parse(tc.args);
      const output = await tool.execute(parsed, ctx);
      return { toolCallId: tc.id, content: output.content, isError: output.isError };
    } catch (err) {
      // 参数校验失败等：同样当观察喂回去
      return {
        toolCallId: tc.id,
        content: `工具 ${tc.name} 执行出错：${(err as Error).message}`,
        isError: true,
      };
    }
  }
}
