import { randomUUID } from "node:crypto";
import type { Conversation } from "../conversation/conversation.js";
import type { Event } from "../conversation/events.js";
import {
  findPendingHumanInteraction,
  type HumanInteractionRequested,
} from "../conversation/events.js";
import { Agent, type RunStatus } from "../agent/agent.js";
import type { AgentRecovery } from "../agent/agent-recovery.js";
import type { RunJournal } from "../observability/run-log.js";
import type { Runtime } from "../runtime/runtime.js";
import { HumanInteractionCoordinator } from "./human-interaction.js";
import {
  noopLogger,
  type TinyhandsLogger,
} from "../logging/logger.js";

/**
 * 单 Conversation 在当前 Host 进程内的活跃执行控制器。
 *
 * Conversation 持有持久身份、配置和事件时间线；AgentSession 只持有当前进程中的
 * Agent、Runtime、RunJournal、driver、interrupt 与关闭状态。
 */
export class AgentSession {
  readonly conversation: Conversation;

  private readonly agent: Agent;
  private readonly recovery: AgentRecovery;
  private readonly journal: RunJournal;
  private readonly runtime: Runtime;
  private readonly log: TinyhandsLogger;

  private runningState = false;
  private runAbort: AbortController | null = null;
  private lastInterruptSeq: number | null = null;
  private drivePromise: Promise<void> | null = null;
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private runtimeStarted = false;

  constructor(opts: {
    conversation: Conversation;
    agent: Agent;
    recovery: AgentRecovery;
    journal: RunJournal;
    runtime: Runtime;
    logger?: TinyhandsLogger;
  }) {
    this.conversation = opts.conversation;
    this.agent = opts.agent;
    this.recovery = opts.recovery;
    this.journal = opts.journal;
    this.runtime = opts.runtime;
    this.log = (opts.logger ?? noopLogger).child({ module: "agent-session" });
  }

  get running(): boolean {
    return this.runningState;
  }

  get waitingForInteraction(): boolean {
    return !!findPendingHumanInteraction(this.conversation.getEvents());
  }

  /** 提交真实用户消息，并在当前 Conversation 空闲时启动后台 driver。 */
  async submit(text: string): Promise<SubmitResult> {
    if (this.closing) throw new Error("AgentSession 正在关闭");
    if (this.waitingForInteraction) {
      throw new ConversationWaitingForInteractionError(this.conversation.id);
    }

    const triggerId = randomUUID();
    const event = await this.conversation.emit({
      type: "user_message",
      source: "user",
      text,
      triggerId,
    });

    if (this.runningState) {
      this.log.info(
        { conversationId: this.conversation.id },
        "已有 run 在跑,新消息已入事件流,本次不重复触发"
      );
      return { triggerId, userMessageSeq: event.seq };
    }

    this.trackDriver(this.driveRun());
    return { triggerId, userMessageSeq: event.seq };
  }

  /** 协作式打断当前 Run；空闲或已打断时幂等返回 false。 */
  async interrupt(): Promise<boolean> {
    if (this.closing) return false;
    const pending = findPendingHumanInteraction(this.conversation.getEvents());
    if (pending && !this.runningState) {
      const event = await this.conversation.emit({
        type: "interrupted",
        source: "user",
      });
      this.lastInterruptSeq = event.seq;
      await new HumanInteractionCoordinator().cancelPending(this.conversation);
      const agentMessage = findAgentMessageForToolCall(
        this.conversation.getEvents(),
        pending.request.target.toolCallId
      );
      if (!agentMessage) throw new Error("interaction 缺少对应 agent_message");
      void this.startContinuation(agentMessage, true);
      return true;
    }
    if (!this.runningState || !this.runAbort) return false;
    if (this.runAbort.signal.aborted) return false;

    const event = await this.conversation.emit({
      type: "interrupted",
      source: "user",
    });
    this.lastInterruptSeq = event.seq;
    this.runAbort.abort();
    return true;
  }

  resumeInteraction(request: HumanInteractionRequested): Promise<void> {
    const agentMessage = findAgentMessageForToolCall(
      this.conversation.getEvents(),
      request.request.target.toolCallId
    );
    if (!agentMessage) {
      return this.conversation
        .emit({
          type: "error",
          source: "agent",
          message: "interaction 缺少对应 agent_message",
        })
        .then(() => {});
    }
    return this.startContinuation(agentMessage);
  }

  /** 恢复规则由 AgentRecovery 统一解释，Session 只负责启动 continuation。 */
  async recover(): Promise<void> {
    const continuation = await this.recovery.recover();
    if (!continuation) return;
    if (continuation.type === "interaction") {
      void this.resumeInteraction(continuation.request);
      return;
    }
    void this.startContinuation(continuation.agentMessage);
  }

  /** 让 driver 静止并关闭 Runtime，不删除持久 Conversation。 */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.runAbort?.abort();
    const closing = (async () => {
      await this.drivePromise;
      await this.runtime.close();
    })();
    this.closePromise = closing;
    void closing.then(undefined, () => {
      if (this.closePromise === closing) this.closePromise = null;
    });
    return closing;
  }

  private async ensureRuntimeReady(): Promise<void> {
    if (this.runtimeStarted) return;
    await this.runtime.start();
    this.runtimeStarted = true;
  }

  private trackDriver(driver: Promise<void>): void {
    this.drivePromise = driver;
    void driver.finally(() => {
      if (this.drivePromise === driver) this.drivePromise = null;
    });
  }

  /**
   * 一次用户可感知推进的 Run driver。Run 完成后使用投影水位线检查 lost-wakeup，
   * 必要时在同一个 driver 中启动下一 Run。
   */
  private async driveRun(): Promise<void> {
    this.runningState = true;
    this.log.info(
      { conversationId: this.conversation.id },
      "开始 agent.run"
    );
    try {
      while (true) {
        const runId = randomUUID();
        await this.journal.append({ type: "run_started", runId });
        const runStartedAt = Date.now();

        let result: Awaited<ReturnType<Agent["run"]>>;
        try {
          await this.ensureRuntimeReady();
          this.runAbort = new AbortController();
          result = await this.agent.run({
            signal: this.runAbort.signal,
            runId,
          });
        } catch (error) {
          try {
            await this.journal.append({
              type: "run_completed",
              runId,
              status: "error",
              projectedThroughSeq: projectedThroughForRun(this.journal, runId),
              durationMs: Date.now() - runStartedAt,
              errorCode: "agent_run_failed",
            });
          } catch (journalError) {
            this.log.error(
              {
                conversationId: this.conversation.id,
                runId,
                err: journalError,
              },
              "run_completed(error) 落盘失败"
            );
          }
          throw error;
        }

        try {
          if (result.status === "suspended") {
            this.log.info(
              { conversationId: this.conversation.id, runId },
              "agent.run 等待 human interaction"
            );
            break;
          }
          const errorCode = runErrorCode(result.status);
          await this.journal.append({
            type: "run_completed",
            runId,
            status: result.status,
            projectedThroughSeq: result.projectedThroughSeq,
            durationMs: Date.now() - runStartedAt,
            ...(errorCode ? { errorCode } : {}),
          });
        } catch (error) {
          this.log.error(
            { conversationId: this.conversation.id, runId, err: error },
            "run_completed 落盘失败，停止继续驱动"
          );
          break;
        }

        this.log.info(
          {
            conversationId: this.conversation.id,
            runId,
            status: result.status,
          },
          "agent.run 结束"
        );
        if (this.closing) break;

        const restartAfterInterrupt =
          result.status === "interrupted" &&
          this.lastInterruptSeq !== null &&
          this.hasUnseenUserMessage(this.lastInterruptSeq);
        if (
          (result.status === "completed" &&
            this.hasUnseenUserMessage(result.projectedThroughSeq)) ||
          restartAfterInterrupt
        ) {
          this.log.info(
            {
              conversationId: this.conversation.id,
              watermark: restartAfterInterrupt
                ? this.lastInterruptSeq
                : result.projectedThroughSeq,
            },
            restartAfterInterrupt
              ? "interrupt 后有新用户消息,立即重跑"
              : "投影水位线后有未见用户消息,立即重跑"
          );
          this.lastInterruptSeq = null;
          continue;
        }
        if (result.status === "interrupted") this.lastInterruptSeq = null;
        break;
      }
    } catch (error) {
      if (!this.closing) {
        try {
          await this.conversation.emit({
            type: "error",
            source: "agent",
            message: "Agent 运行失败",
          });
        } catch (emitError) {
          this.log.error(
            { conversationId: this.conversation.id, err: emitError },
            "兜底 error 事件落盘失败(磁盘/IO),仅记日志"
          );
        }
      }
      this.log.error(
        { conversationId: this.conversation.id, err: error },
        "agent.run 异常"
      );
    } finally {
      this.runningState = false;
      this.runAbort = null;
    }
  }

  /** 解决 interaction 或崩溃恢复后，从原 agent_message 坐标继续同一 Run。 */
  private startContinuation(
    agentMessage: Extract<Event, { type: "agent_message" }>,
    abortImmediately = false
  ): Promise<void> {
    if (this.runningState) return this.drivePromise ?? Promise.resolve();
    const driver = (async () => {
      this.runningState = true;
      const runId = agentMessage.executionTrace?.runId;
      try {
        if (!runId) throw new Error("agent_message 缺少恢复坐标");
        await this.ensureRuntimeReady();
        this.runAbort = new AbortController();
        if (abortImmediately) this.runAbort.abort();
        const result = await this.agent.resume({
          runId,
          signal: this.runAbort.signal,
          agentMessage,
        });
        if (result.status === "suspended") return;
        await this.journal.append({
          type: "run_completed",
          runId,
          status: result.status,
          projectedThroughSeq: result.projectedThroughSeq,
          durationMs: 0,
          ...(runErrorCode(result.status)
            ? { errorCode: runErrorCode(result.status) }
            : {}),
        });
      } catch (error) {
        try {
          await this.conversation.emit({
            type: "error",
            source: "agent",
            message: "Agent 恢复运行失败",
          });
        } catch {
          // Conversation 落盘错误由服务端日志兜底。
        }
        this.log.error(
          { conversationId: this.conversation.id, runId, err: error },
          "interaction continuation 异常"
        );
      } finally {
        this.runningState = false;
        this.runAbort = null;
      }
    })();
    this.trackDriver(driver);
    return driver;
  }

  private hasUnseenUserMessage(watermark: number): boolean {
    return this.conversation
      .getEventsSince(watermark)
      .some((event) => event.type === "user_message");
  }
}

export interface SubmitResult {
  triggerId: string;
  userMessageSeq: number;
}

function findAgentMessageForToolCall(
  events: readonly Event[],
  toolCallId: string
): Extract<Event, { type: "agent_message" }> | undefined {
  return [...events].reverse().find(
    (event): event is Extract<Event, { type: "agent_message" }> =>
      event.type === "agent_message" &&
      event.toolCalls.some((call) => call.id === toolCallId)
  );
}

function runErrorCode(status: RunStatus): string | undefined {
  if (status === "error") return "agent_run_error";
  if (status === "max_steps_exceeded") return "max_steps_exceeded";
  return undefined;
}

function projectedThroughForRun(journal: RunJournal, runId: string): number {
  for (const record of journal.getRecords().reverse()) {
    if (record.type === "step_started" && record.runId === runId) {
      return record.projectedThroughSeq;
    }
  }
  return 0;
}

export class ConversationWaitingForInteractionError extends Error {
  constructor(conversationId: string) {
    super(`conversation 正在等待 human interaction：${conversationId}`);
  }
}
