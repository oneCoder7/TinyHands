import type { LLMResponse } from "../../llm/types.js";

export interface ResponseRejection {
  reason: "max_tokens" | "content_filter" | "refusal";
  message: string;
}

export interface ResponseValidator {
  readonly id: string;
  validate(
    stopReason: LLMResponse["stopReason"]
  ): Promise<ResponseRejection | undefined>;
}

export class ResponseValidationError extends Error {
  constructor(readonly componentId: string) {
    super(`Agent response validator failed: ${componentId}`);
    this.name = "ResponseValidationError";
  }
}

export function assertUniqueResponseValidatorIds(
  validators: readonly ResponseValidator[]
): void {
  const ids = new Set<string>();
  for (const validator of validators) {
    if (!validator.id) throw new Error("Response Validator ID 不能为空");
    if (ids.has(validator.id)) {
      throw new Error(`Response Validator ID 重复：${validator.id}`);
    }
    ids.add(validator.id);
  }
}

export async function validateResponse(
  validators: readonly ResponseValidator[],
  stopReason: LLMResponse["stopReason"]
): Promise<ResponseRejection | undefined> {
  for (const validator of validators) {
    let rejection: ResponseRejection | undefined;
    try {
      rejection = await validator.validate(stopReason);
    } catch {
      throw new ResponseValidationError(validator.id);
    }
    if (!rejection) continue;
    if (!isReason(rejection.reason) || !rejection.message) {
      throw new ResponseValidationError(validator.id);
    }
    return rejection;
  }
  return undefined;
}

function isReason(value: unknown): value is ResponseRejection["reason"] {
  return value === "max_tokens" || value === "content_filter" || value === "refusal";
}
