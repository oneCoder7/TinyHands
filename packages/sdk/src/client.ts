import {
  isPublicStreamItem,
  isTinyhandsErrorBody,
  type CreateConversationInput,
  type DeleteConversationResult,
  type InterruptResult,
  type PublicStreamItem,
  type SendMessageResult,
  type StreamClosedControl,
  type TinyhandsErrorCode,
} from "@tinyhands/protocol";

export interface TinyhandsClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  headers?: TinyhandsHeadersInit | (() => TinyhandsHeadersInit | Promise<TinyhandsHeadersInit>);
}

export type TinyhandsHeadersInit = ConstructorParameters<typeof Headers>[0];

export interface ClientEventOptions {
  signal?: AbortSignal;
  afterSeq?: number;
}

export class TinyhandsClientError extends Error {
  readonly code: TinyhandsErrorCode;
  readonly status: number | undefined;

  constructor(code: TinyhandsErrorCode, message: string, status?: number) {
    super(message);
    this.name = "TinyhandsClientError";
    this.code = code;
    this.status = status;
  }
}

export class TinyhandsClient {
  readonly conversations: ConversationClient;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headersSource: TinyhandsClientOptions["headers"];

  constructor(options: TinyhandsClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!this.baseUrl) throw new Error("baseUrl 不能为空");
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new Error("当前环境没有 fetch，请显式传入 fetch 实现");
    this.fetchImpl = fetchImpl;
    this.headersSource = options.headers;
    this.conversations = new ConversationClient(this);
  }

  conversation(conversationId: string): ConversationHandle {
    return new ConversationHandle(this, conversationId);
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = await this.resolveHeaders(init.headers);
    const response = await this.fetchImpl(`${this.baseUrl}/v1${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) throw await clientErrorFromResponse(response);
    return (await response.json()) as T;
  }

  async openEventResponse(
    conversationId: string,
    lastSeq: number,
    signal: AbortSignal | undefined
  ): Promise<Response> {
    const headers = await this.resolveHeaders(
      lastSeq > 0 ? { "last-event-id": String(lastSeq) } : undefined
    );
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/events`,
      { method: "GET", headers, signal }
    );
    if (!response.ok) throw await clientErrorFromResponse(response);
    if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
      throw new TinyhandsClientError(
        "internal_error",
        "事件接口没有返回 text/event-stream",
        response.status
      );
    }
    if (!response.body) {
      throw new TinyhandsClientError("internal_error", "SSE response body 为空");
    }
    return response;
  }

  private async resolveHeaders(extra?: TinyhandsHeadersInit): Promise<Headers> {
    const configured =
      typeof this.headersSource === "function"
        ? await this.headersSource()
        : this.headersSource;
    const headers = new Headers(configured);
    if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
    return headers;
  }
}

export class ConversationClient {
  constructor(private readonly client: TinyhandsClient) {}

  async create(input: CreateConversationInput = {}): Promise<ConversationHandle> {
    const created = await this.client.request<{ conversationId: string }>(
      "/conversations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }
    );
    return this.client.conversation(created.conversationId);
  }

  async list(): Promise<
    Array<{ conversationId: string; createdAt: number; running: boolean }>
  > {
    const result = await this.client.request<{
      conversations: Array<{
        conversationId: string;
        createdAt: number;
        running: boolean;
      }>;
    }>("/conversations");
    return result.conversations;
  }
}

export class ConversationHandle {
  constructor(
    private readonly client: TinyhandsClient,
    readonly conversationId: string
  ) {}

  send(text: string): Promise<SendMessageResult> {
    return this.client.request(
      `/conversations/${encodeURIComponent(this.conversationId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }
    );
  }

  interrupt(): Promise<InterruptResult> {
    return this.client.request(
      `/conversations/${encodeURIComponent(this.conversationId)}/interrupt`,
      { method: "POST" }
    );
  }

  delete(): Promise<DeleteConversationResult> {
    return this.client.request(
      `/conversations/${encodeURIComponent(this.conversationId)}`,
      { method: "DELETE" }
    );
  }

  events(options: ClientEventOptions = {}): AsyncIterable<PublicStreamItem> {
    return streamEvents(this.client, this.conversationId, options);
  }
}

async function* streamEvents(
  client: TinyhandsClient,
  conversationId: string,
  options: ClientEventOptions
): AsyncGenerator<PublicStreamItem> {
  let lastSeq = validateAfterSeq(options.afterSeq);
  let retryMs = 1000;

  while (!options.signal?.aborted) {
    let response: Response;
    try {
      response = await client.openEventResponse(
        conversationId,
        lastSeq,
        options.signal
      );
    } catch (error) {
      if (options.signal?.aborted) return;
      if (error instanceof TinyhandsClientError) throw error;
      await waitForRetry(retryMs, options.signal);
      continue;
    }
    if (options.signal?.aborted) {
      await response.body?.cancel();
      return;
    }

    let reconnectImmediately = false;
    try {
      for await (const frame of parseSse(response.body!, options.signal)) {
        if (options.signal?.aborted) return;
        if (frame.retry !== undefined) retryMs = Math.max(0, frame.retry);
        if (frame.data === undefined) continue;

        let value: unknown;
        try {
          value = JSON.parse(frame.data);
        } catch {
          throw new TinyhandsClientError("internal_error", "SSE data 不是合法 JSON");
        }

        if (frame.event === "tinyhands.control") {
          const control = parseControl(value);
          if (control.code === "event_stream_overflow") {
            reconnectImmediately = true;
            break;
          }
          throw new TinyhandsClientError(control.code, control.message);
        }

        if (!isPublicStreamItem(value)) {
          throw new TinyhandsClientError("internal_error", "SSE 公开事件格式非法");
        }
        if (frame.id !== undefined && !("delta" in value)) {
          const seq = Number(frame.id);
          if (!Number.isSafeInteger(seq) || seq < 0 || seq !== value.seq) {
            throw new TinyhandsClientError("internal_error", "SSE event id 与 seq 不一致");
          }
          lastSeq = seq;
        }
        yield value;
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      if (error instanceof TinyhandsClientError) throw error;
    }

    if (!reconnectImmediately) await waitForRetry(retryMs, options.signal);
  }
}

interface SseFrame {
  event?: string;
  data?: string;
  id?: string;
  retry?: number;
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const onAbort = () => void reader.cancel();
  if (signal?.aborted) {
    void reader.cancel();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        yield parseSseBlock(block);
      }
    }
    buffer += decoder.decode();
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // 迭代已经结束，取消失败不能覆盖调用方原本的 return/异常。
      }
    }
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): SseFrame {
  const frame: SseFrame = {};
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") frame.event = value;
    else if (field === "id") frame.id = value;
    else if (field === "retry") {
      const retry = Number(value);
      if (Number.isSafeInteger(retry) && retry >= 0) frame.retry = retry;
    }
  }
  if (data.length > 0) frame.data = data.join("\n");
  return frame;
}

function parseControl(value: unknown): StreamClosedControl {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { type?: unknown }).type !== "stream_closed" ||
    typeof (value as { code?: unknown }).code !== "string" ||
    !CONTROL_CODES.has(
      (value as { code: string }).code as StreamClosedControl["code"]
    ) ||
    typeof (value as { message?: unknown }).message !== "string"
  ) {
    throw new TinyhandsClientError("internal_error", "SSE control frame 格式非法");
  }
  return value as StreamClosedControl;
}

const CONTROL_CODES = new Set<StreamClosedControl["code"]>([
  "conversation_deleted",
  "event_stream_overflow",
  "host_closing",
  "host_closed",
]);

async function clientErrorFromResponse(
  response: Response
): Promise<TinyhandsClientError> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return new TinyhandsClientError(
      "internal_error",
      `HTTP ${response.status} 响应不是合法错误体`,
      response.status
    );
  }
  if (!isTinyhandsErrorBody(value)) {
    return new TinyhandsClientError(
      "internal_error",
      `HTTP ${response.status} 错误体格式非法`,
      response.status
    );
  }
  return new TinyhandsClientError(
    value.error.code,
    value.error.message,
    response.status
  );
}

function validateAfterSeq(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("afterSeq 必须是非负整数");
  }
  return value;
}

function waitForRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
