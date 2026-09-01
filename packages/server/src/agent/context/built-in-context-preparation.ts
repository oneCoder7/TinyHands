import { projectCompactedContext } from "../../conversation/events.js";
import type { Tool } from "../../tools/tool.js";
import {
  CompactionError,
  ContextCompactor,
} from "./context-compactor.js";
import {
  ContextPreparationError,
  type ContextPreparation,
  type PreparedAgentRequest,
} from "./context-preparation.js";

export class BuiltInContextPreparation implements ContextPreparation {
  readonly id = "builtin.context-preparation";

  constructor(
    private readonly tools: readonly Tool[],
    private readonly compactor?: Pick<ContextCompactor, "prepare">
  ) {}

  async prepare(
    input: Parameters<ContextPreparation["prepare"]>[0]
  ): Promise<PreparedAgentRequest> {
    try {
      if (this.compactor) {
        const prepared = await this.compactor.prepare(
          [...input.events],
          [...this.tools],
          {
            runId: input.coordinates.runId,
            step: input.coordinates.step,
            signal: input.signal,
          }
        );
        return {
          messages: prepared.messages,
          systemContext: prepared.systemContext,
        };
      }
      const projected = projectCompactedContext([...input.events]);
      return {
        messages: projected.messages,
        systemContext: projected.systemContext,
      };
    } catch (error) {
      if (error instanceof CompactionError) throw error;
      throw new ContextPreparationError(this.id);
    }
  }
}
