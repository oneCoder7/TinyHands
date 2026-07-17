import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod/v4";
import {
  ConversationExistsError,
  ConversationNotFoundError,
  InvalidConversationInputError,
  type ConversationService,
} from "@tinyhands/server";

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
 * list 只返回稳定 ConversationInfo；legacy 路由不再暴露 transport 连接数或
 * resident/eventCount 等内部诊断字段。
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
  manager: ConversationService
): void {
  // 健康探针(部署/编排要,保持 GET)
  fastify.get("/health", async () => ({
    status: "ok",
    conversations: (await manager.list()).length,
  }));

  fastify.post("/conversations/create", async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "参数不合法：conversationId 须为非空字符串" };
    }

    const { tools } = parsed.data;
    // id 冲突/工具非法由 Service 抛类型化错误，server error handler 统一映射。
    const created = await callService(reply, () =>
      manager.create({
        conversationId: parsed.data.conversationId,
        tools,
      })
    );
    if ("error" in created) return created;
    reply.code(201);
    return created;
  });

  fastify.post("/conversations/list", async () => ({
    conversations: await manager.list(),
  }));

  fastify.post("/conversations/delete", async (req, reply) => {
    const parsed = DeleteBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "缺少 conversationId" };
    }
    return callService(reply, () => manager.delete(parsed.data.conversationId));
  });

  // —— 会话内命令(上行统一 REST,一行转交会话侧,router 不碰 agent 运行) ——

  // 发消息。响应只是受理确认(消息经事件流回显给所有订阅者),不含 agent 回复。
  fastify.post("/conversations/send", async (req, reply) => {
    const parsed = SendBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "参数不合法：需要 conversationId 与非空 text" };
    }
    return callService(reply, () =>
      manager.send(parsed.data.conversationId, parsed.data.text)
    );
  });

  // 打断进行中的 run。interrupted:false = 幂等 no-op(空闲或已在打断中)。
  fastify.post("/conversations/interrupt", async (req, reply) => {
    const parsed = InterruptBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: "缺少 conversationId" };
    }
    return callService(reply, () => manager.interrupt(parsed.data.conversationId));
  });
}

async function callService<T>(
  reply: FastifyReply,
  action: () => Promise<T>
): Promise<T | { error: string }> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof InvalidConversationInputError) {
      reply.code(400);
      return { error: err.message };
    }
    if (err instanceof ConversationNotFoundError) {
      reply.code(404);
      return { error: err.message };
    }
    if (err instanceof ConversationExistsError) {
      reply.code(409);
      return { error: err.message };
    }
    throw err;
  }
}
