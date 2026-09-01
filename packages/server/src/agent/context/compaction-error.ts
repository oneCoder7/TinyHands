import type { CompactionFailureCode } from "../../conversation/events.js";

export class CompactionError extends Error {
  constructor(readonly code: CompactionFailureCode, message: string) {
    super(message);
    this.name = "CompactionError";
  }
}

export class CompactionInterruptedError extends Error {
  constructor() {
    super("上下文压缩已被用户中断");
    this.name = "CompactionInterruptedError";
  }
}
