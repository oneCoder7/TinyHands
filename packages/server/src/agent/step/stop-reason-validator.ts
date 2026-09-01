import type {
  ResponseRejection,
  ResponseValidator,
} from "./response-validator.js";

export class StopReasonValidator implements ResponseValidator {
  readonly id = "builtin.stop-reason-validator";

  async validate(
    stopReason: Parameters<ResponseValidator["validate"]>[0]
  ): Promise<ResponseRejection | undefined> {
    switch (stopReason) {
      case "max_tokens":
        return { reason: stopReason, message: "LLM 输出被截断，本轮结果不可信" };
      case "content_filter":
        return { reason: stopReason, message: "LLM 输出被内容过滤，本轮未执行" };
      case "refusal":
        return { reason: stopReason, message: "LLM 拒绝了本轮请求，本轮未执行" };
      default:
        return undefined;
    }
  }
}
