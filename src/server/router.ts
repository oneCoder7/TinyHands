import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import type { ConversationManager } from "./conversation-manager.js";
import { submitUserMessage, interruptRun } from "./agent-session.js";
import { listOptionalToolNames } from "../tools/catalog.js";

/**
 * REST router —— 会话生命周期 + 会话内命令接口。
 *
 * 一律 POST(RPC 风格),不用 GET/DELETE 动词 —— GET 会被代理/浏览器缓存出过期
 * 数据;/health 例外(k8s 探针标准)。上行(命令面)统一走 REST:send/interrupt
 * 在此,WS/SSE 只做下行观察窗口。
 *
 * body 校验用 zod 手动 parse(不引 type provider:当前 zod 是 zod/v4 子路径形态,
 * fastify-type-provider-zod v6+ 不兼容)。参数不合法就地回 400;业务冲突(如 id
 * 已存在)由 manager 抛类型化错误,setErrorHandler 统一映射 409。
 *
 * connections(在连 WS 数)由 gateway 注入的 getConnectionCount 提供:manager 不认识
 * 连接,router 组装 list 响应时才把两者拼起来。
 */

// conversationId 白名单:字母/数字/下划线/连字符,1-64 位。路径穿越的第一道防线 ——
// id 会被 join 进 workspace 路径,排除 / . 等字符,堵死 "../../x" 之类穿越。
const ConvId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, {
  message: "conversationId 仅允许 [A-Za-z0-9_-]，长度 1-64",
});
const CreateBody = z.object({
  conversationId: ConvId.optional(),
  /**
   * 要启用的可选工具列表。必选工具(read_file/write_file/finish)始终注册,
   * 无需也无法通过此字段控制。不传时默认只启用 run_bash(向后兼容)。
   */
  tools: z.array(z.string()).optional(),
});
const DeleteBody = z.object({ conversationId: ConvId });
const SendBody = z.object({ conversationId: ConvId, text: z.string().min(1) });
const InterruptBody = z.object({ conversationId: ConvId });

export function registerRoutes(
  fastify: FastifyInstance,
  manager: ConversationManager,
  getConnectionCount: (id: string) => number
): void {
  // 健康探针(部署/编排要,保持 GET)
  fastify.get("/health", async () => ({
    status: "ok",
    conversations: manager.list().length,
  }));

  fastify.post("/conversations/create", async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "参数不合法：conversationId 须为非空字符串" };
    }

    // 校验 tools 列表中的工具名是否都在目录中
    const { tools } = parsed.data;
    if (tools) {
      const known = listOptionalToolNames();
      const unknown = tools.filter((t) => !known.includes(t));
      if (unknown.length > 0) {
        reply.code(400);
        return {
          error: `未知的工具:${unknown.join(", ")}。可用工具:${known.join(", ")}`,
        };
      }
    }

    // id 冲突时 manager 抛 ConversationExistsError → setErrorHandler 转 409
    const session = await manager.create(parsed.data.conversationId, tools);
    reply.code(201);
    return {
      conversationId: session.conversationId,
      createdAt: session.createdAt,
    };
  });

  fastify.post("/conversations/list", async () => ({
    conversations: manager.list().map((s) => ({
      ...s,
      connections: getConnectionCount(s.conversationId),
    })),
  }));

  fastify.post("/conversations/delete", async (req, reply) => {
    const parsed = DeleteBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "缺少 conversationId" };
    }
    const deleted = await manager.destroy(parsed.data.conversationId);
    if (!deleted) {
      reply.code(404);
      return { error: `conversation 不存在：${parsed.data.conversationId}` };
    }
    return { deleted: true };
  });

  // —— 会话内命令(上行统一 REST,一行转交会话侧,router 不碰 agent 运行) ——

  // 发消息。响应只是受理确认(消息经事件流回显给所有订阅者),不含 agent 回复。
  fastify.post("/conversations/send", async (req, reply) => {
    const parsed = SendBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "参数不合法：需要 conversationId 与非空 text" };
    }
    const session = manager.get(parsed.data.conversationId);
    if (!session) {
      reply.code(404);
      return { error: `conversation 不存在：${parsed.data.conversationId}` };
    }
    submitUserMessage(session, parsed.data.text);
    // driveRun 同步段已置位 running,此处读到的是受理后的即时状态
    return { accepted: true, running: session.running };
  });

  // 打断进行中的 run。interrupted:false = 幂等 no-op(空闲或已在打断中)。
  fastify.post("/conversations/interrupt", async (req, reply) => {
    const parsed = InterruptBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "缺少 conversationId" };
    }
    const session = manager.get(parsed.data.conversationId);
    if (!session) {
      reply.code(404);
      return { error: `conversation 不存在：${parsed.data.conversationId}` };
    }
    return { interrupted: interruptRun(session) };
  });
}
