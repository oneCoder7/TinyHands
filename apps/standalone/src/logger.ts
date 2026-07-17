import { pino } from "pino";

/** standalone 进程日志；读取 LOG_* 是应用组装职责，不进入 Server library。 */
const VALID_LEVELS = ["debug", "info", "warn", "error"];
const levelRaw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
const level = VALID_LEVELS.includes(levelRaw) ? levelRaw : "info";

export const logger = pino({
  level,
  ...(process.env.LOG_FORMAT === "json"
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
        },
      }),
});
