import { pino } from "pino";

/**
 * 全局日志 —— pino 实例(进程级单例)。
 *
 * 为什么是 pino:fastify v5 直接依赖它(本就在依赖树里),异步缓冲写
 * 不阻塞事件循环(异步纪律),同一实例传给 fastify(loggerInstance)后
 * 框架内部日志(请求日志/404/WS 升级失败)与应用日志合流。
 *
 * 为什么直接读环境变量而不经 getConfig():config 校验失败(如缺 API key)时
 * 恰恰需要 logger 来报错 —— logger 必须先于 config 可用。
 *
 * 用法:模块内 `const log = logger.child({ module: "xxx" })`,
 * 打日志按 pino 惯例字段在前:`log.info({ conversationId }, "会话已创建")`。
 *
 * 环境变量:
 *  - LOG_LEVEL: debug | info | warn | error(默认 info)
 *  - LOG_FORMAT: json = 原生 JSON 行(生产采集);其他 = pino-pretty 人读格式(开发)
 */

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
