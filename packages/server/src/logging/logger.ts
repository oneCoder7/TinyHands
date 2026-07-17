export interface TinyhandsLogMethod {
  (message: string): void;
  (bindings: Record<string, unknown>, message: string): void;
}

/** Server 只依赖此最小日志端口，不在公共类型中绑定 Pino。 */
export interface TinyhandsLogger {
  child(bindings: Record<string, unknown>): TinyhandsLogger;
  debug: TinyhandsLogMethod;
  info: TinyhandsLogMethod;
  warn: TinyhandsLogMethod;
  error: TinyhandsLogMethod;
}

const discard: TinyhandsLogMethod = () => {};

/** 嵌入方未注入 logger 时保持静默，也不产生 import-time 副作用。 */
export const noopLogger: TinyhandsLogger = {
  child: () => noopLogger,
  debug: discard,
  info: discard,
  warn: discard,
  error: discard,
};
