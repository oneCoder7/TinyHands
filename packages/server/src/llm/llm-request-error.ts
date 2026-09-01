export type LLMRequestErrorCode =
  | "authentication"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "protocol"
  | "unknown";

/** Provider-neutral model request failure used by the Agent retry boundary. */
export class LLMRequestError extends Error {
  readonly code: LLMRequestErrorCode;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(options: {
    code: LLMRequestErrorCode;
    retryable: boolean;
    cause?: unknown;
  }) {
    super(`LLM request failed: ${options.code}`);
    this.name = "LLMRequestError";
    this.code = options.code;
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
}

/**
 * Normalize the stable parts shared by the currently supported SDK errors.
 * Unknown shapes are deliberately non-retryable: the Agent must not guess.
 */
export function normalizeLLMRequestError(error: unknown): LLMRequestError {
  if (error instanceof LLMRequestError) return error;

  const status = readNumber(error, "status");
  const code = readString(error, "code")?.toLowerCase();
  const name = readString(error, "name")?.toLowerCase();

  if (status === 401 || status === 403) {
    return new LLMRequestError({ code: "authentication", retryable: false, cause: error });
  }
  if (status === 400 || status === 404 || status === 422) {
    return new LLMRequestError({ code: "invalid_request", retryable: false, cause: error });
  }
  if (status === 429 || code === "rate_limit_exceeded") {
    return new LLMRequestError({ code: "rate_limited", retryable: true, cause: error });
  }
  if (
    status === 408 ||
    code === "etimedout" ||
    code === "timeout" ||
    name === "apitimeouterror"
  ) {
    return new LLMRequestError({ code: "timeout", retryable: true, cause: error });
  }
  if (
    status === 409 ||
    (typeof status === "number" && status >= 500 && status <= 599) ||
    code === "econnreset" ||
    code === "econnrefused" ||
    name === "apiconnectionerror"
  ) {
    return new LLMRequestError({ code: "unavailable", retryable: true, cause: error });
  }

  return new LLMRequestError({ code: "unknown", retryable: false, cause: error });
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "string" ? result : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  const result = (value as Record<string, unknown>)[key];
  return typeof result === "number" ? result : undefined;
}
