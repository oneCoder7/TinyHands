import { describe, expect, it } from "vitest";
import {
  LLMRequestError,
  normalizeLLMRequestError,
} from "../llm-request-error.js";

describe("normalizeLLMRequestError", () => {
  it.each([
    [{ status: 401 }, "authentication", false],
    [{ status: 400 }, "invalid_request", false],
    [{ status: 429 }, "rate_limited", true],
    [{ status: 408 }, "timeout", true],
    [{ status: 503 }, "unavailable", true],
  ] as const)("将已知 SDK/HTTP 错误映射为稳定错误 %#", (source, code, retryable) => {
    expect(normalizeLLMRequestError(source)).toMatchObject({ code, retryable });
  });

  it("未知错误固定不可重试，并保留内部 cause", () => {
    const source = new Error("provider secret");
    const normalized = normalizeLLMRequestError(source);
    expect(normalized).toMatchObject({ code: "unknown", retryable: false });
    expect(normalized.cause).toBe(source);
  });

  it("已规范化错误保持实例与语义", () => {
    const source = new LLMRequestError({ code: "protocol", retryable: false });
    expect(normalizeLLMRequestError(source)).toBe(source);
  });
});
