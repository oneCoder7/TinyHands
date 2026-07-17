#!/usr/bin/env node
/**
 * 真实 Provider smoke：只输出协议结果，不输出凭据、prompt、回复或 replay 正文。
 *
 * 覆盖纯文本、同轮多工具、工具结果回传、重建 client 后续聊及流式 interrupt。
 * 这是手动交付验收，不进入 Vitest/CI，运行时会产生少量真实 token 消耗。
 */
import "dotenv/config";
import { z } from "zod/v4";
import { readStandaloneConfig } from "../apps/standalone/src/config.js";
import { createLLMClient } from "../packages/server/src/llm/factory.js";
import type { Message } from "../packages/server/src/llm/types.js";
import type { Tool } from "../packages/server/src/tools/tool.js";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const config = readStandaloneConfig(process.env).host;
const llm = createLLMClient(config.llm);
const stream = { onDelta: () => {} };

const probeAlpha: Tool<Record<string, never>> = {
  name: "probe_alpha",
  description: "验收工具 A；当用户要求 provider smoke 时必须调用。",
  schema: z.object({}),
  async execute() {
    return { content: "alpha-ok", isError: false };
  },
};
const probeBeta: Tool<Record<string, never>> = {
  name: "probe_beta",
  description: "验收工具 B；当用户要求 provider smoke 时必须调用。",
  schema: z.object({}),
  async execute() {
    return { content: "beta-ok", isError: false };
  },
};
const tools = [probeAlpha, probeBeta];

async function verifyText(): Promise<void> {
  const response = await llm.chat(
    [{ role: "user", text: "只回复 OK，不要调用工具。" }],
    [],
    { ...stream, maxTokens: 1024 }
  );
  invariant(response.stopReason === "end_turn", "纯文本请求没有正常 end_turn");
  invariant(response.text.trim().length > 0, "纯文本请求没有正文");
  invariant(response.toolCalls.length === 0, "纯文本请求意外调用工具");
  console.log("✓ 纯文本 streaming Chat");
}

async function verifyMultiToolAndRestart(): Promise<void> {
  const prompt =
    "这是 provider smoke。必须在同一个响应中同时调用 probe_alpha 和 probe_beta，" +
    "不要等待第一个结果，不要调用其他工具；拿到两个结果后再回复完成。";
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await llm.chat([{ role: "user", text: prompt }], tools, {
      ...stream,
      maxTokens: 2048,
    });
    const names = new Set(response.toolCalls.map((call) => call.name));
    if (names.has("probe_alpha") && names.has("probe_beta")) break;
  }
  invariant(response, "多工具请求没有返回响应");
  const names = new Set(response.toolCalls.map((call) => call.name));
  invariant(names.has("probe_alpha"), "同轮响应缺少 probe_alpha");
  invariant(names.has("probe_beta"), "同轮响应缺少 probe_beta");
  invariant(response.toolCalls.length === 2, "同轮响应包含预期外工具调用");
  console.log("✓ 同轮多工具调用");

  const history: Message[] = [
    { role: "user", text: prompt },
    {
      role: "assistant",
      text: response.text,
      toolCalls: response.toolCalls,
      providerReplay: response.providerReplay,
    },
    ...response.toolCalls.map(
      (call): Message => ({
        role: "tool",
        toolResult: {
          toolCallId: call.id,
          content: call.name === "probe_alpha" ? "alpha-ok" : "beta-ok",
          isError: false,
        },
      })
    ),
  ];
  // 重建 client，证明后续调用不依赖旧 SDK 实例的内存状态。
  const restarted = createLLMClient(config.llm);
  const followup = await restarted.chat(history, [], {
    ...stream,
    maxTokens: 1024,
  });
  invariant(followup.stopReason === "end_turn", "工具结果回传后没有正常结束");
  invariant(followup.text.trim().length > 0, "工具结果回传后没有正文");
  console.log("✓ 工具结果回传 + 重建 client 后续聊");
}

async function verifyInterrupt(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  let interrupted = false;
  try {
    await llm.chat(
      [
        {
          role: "user",
          text: "详细推导一个很长的数学证明，至少写五千字。",
        },
      ],
      [],
      {
        ...stream,
        maxTokens: 4096,
        signal: controller.signal,
      }
    );
  } catch {
    interrupted = controller.signal.aborted;
  } finally {
    clearTimeout(timer);
  }
  invariant(interrupted, "流式请求没有被 AbortSignal 中断");
  console.log("✓ 流式 AbortSignal interrupt");
}

async function main(): Promise<void> {
  console.log(
    `Provider smoke: ${llm.identity.provider}/${llm.identity.model} (${llm.identity.apiMode})`
  );
  await verifyText();
  await verifyMultiToolAndRestart();
  await verifyInterrupt();
  console.log("✓ PASS —— Provider 真实 E2E smoke 全部通过");
}

main().catch((error) => {
  console.error(`✗ Provider smoke 失败：${(error as Error).message}`);
  process.exit(1);
});
