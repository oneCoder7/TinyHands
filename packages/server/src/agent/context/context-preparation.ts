import type { Event } from "../../conversation/events.js";
import type { Message } from "../../llm/types.js";

export interface AgentStepCoordinates {
  runId: string;
  step: number;
  projectedThroughSeq: number;
}

export interface PreparedAgentRequest {
  messages: Message[];
  systemContext: string[];
}

export interface ContextPreparation {
  readonly id: string;
  prepare(input: Readonly<{
    events: readonly Event[];
    coordinates: AgentStepCoordinates;
    signal?: AbortSignal;
  }>): Promise<PreparedAgentRequest>;
}

export class ContextPreparationError extends Error {
  constructor(readonly componentId: string) {
    super(`Agent context preparation failed: ${componentId}`);
    this.name = "ContextPreparationError";
  }
}
