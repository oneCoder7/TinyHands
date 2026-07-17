#!/usr/bin/env node
/**
 * 真进程级崩溃恢复验证(非回归测试)。
 *
 * 为什么单独搞个脚本、不进 vitest:
 *  - 要跑真 LLM(花真 token、依赖 .env 凭据、响应慢,几十秒级)—— 不适合进 CI 单测;
 *  - 要真起服务进程 + 真 kill -9 + 重启 —— vitest 进程内做不到进程级崩溃;
 *  - 价值在「证明」而非「回归」:验设计文档 §5 的核心假设「appendFile 只到 page cache,
 *    kill -9/OOM 由 OS 兜底刷盘不丢」,以及 §6 验收1「进程 kill → 重启 → 同 id 拿回完整历史」。
 *    集成测试(conversation-service.test.ts)是「丢内存实例再 new 一个」模拟崩溃,逻辑等价
 *    但从未跨过真进程边界、没用真 kill -9 —— 本脚本补这一层。
 *
 * 跑法:npm run verify:crash
 * 前提:.env 已按 provider/model 配置 LLM_MODEL 和可用 API key；私有网关还需
 *       LLM_BASE_URL，OpenAI-compatible Chat 网关需 LLM_OPENAI_API_MODE=chat_completions。
 *       LLM 不可达时脚本会降级:agent.run 报 error 落盘,仍验恢复+续号,但不产生 tool_use。
 *
 * 黑盒:不 import 项目内部模块,只通过 HTTP + SSE + 直接读 events.jsonl 交互。
 * 隔离:TINYHANDS_HOME 用临时目录,不污染真实家目录 ~/workspace;RUNTIME 强制 local(免 docker 依赖)。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, "..");

const PORT = 18799; // 选个不常用端口,避免和已跑服务冲突
const CONV = "crash-demo";
const BASE = `http://127.0.0.1:${PORT}`;
const MAX_STEP_RUNTIME_MS = 120_000; // agent 跑一轮的上限(LLM + 工具)
const LLM_FOLLOWUP_MS = 60_000; // 续聊后等 agent 产生下一条事件的上限

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

/** 轮询等待条件成立,超时抛错。 */
async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs: number,
  label: string,
  intervalMs = 300
): Promise<T> {
  const deadline = now() + timeoutMs;
  let lastErr: unknown;
  while (now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor 超时 [${label}] lastErr=${String(lastErr)}`);
}

const post = (path: string, body: unknown) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/**
 * 起一个服务进程,stdout/stderr 落日志文件。返回 child + 日志路径。
 *
 * 进程管理要点(踩坑后修正):
 *  - 用 `node --import tsx` 单进程模型,而非 `tsx` CLI —— tsx CLI 会把代码跑在子进程里,
 *    父进程退出时子进程成孤儿继续 LISTEN,导致 kill 父进程杀不掉真服务、端口残留、
 *    重跑撞 409。node --import tsx 在单进程内跑,child.pid 就是服务进程本身。
 *  - detached:true 让 child 成为独立进程组 leader(pid=pgid),kill 时用 -pid 杀整组,
 *    确保 exec/runCode 起的任何孙进程也一并清掉,不留孤儿。
 */
function startService(tag: string, tmpRoot: string): { child: ChildProcess; logPath: string } {
  const logPath = join(tmpRoot, `service-${tag}.log`);
  const logFd = openSync(logPath, "w");
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "apps/standalone/src/main.ts"],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        TINYHANDS_HOME: tmpRoot,
        RUNTIME: "local", // 强制本机,免 docker 依赖
      },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    }
  );
  child.on("exit", (code, sig) => {
    console.log(`  [service-${tag}] 退出 code=${code} sig=${sig}`);
  });
  return { child, logPath };
}

async function waitForHealth(tag: string): Promise<void> {
  await waitFor(
    async () => {
      try {
        const r = await fetch(`${BASE}/health`);
        return r.ok ? (r.json() as Promise<unknown>) : undefined;
      } catch {
        return undefined;
      }
    },
    20_000,
    `service-${tag} /health`
  );
}

/** 轮询 list,等会话 idle(running=false 且 eventCount 稳定 1.5s)。返回最终事件数。 */
async function waitForIdle(convId: string): Promise<number> {
  let lastCount = -1;
  let stableAt = 0;
  return waitFor(
    async () => {
      const r = await post("/conversations/list", {});
      const j = (await r.json()) as { conversations: Array<{ conversationId: string; running: boolean; eventCount: number }> };
      const c = j.conversations.find((x) => x.conversationId === convId);
      if (!c) return undefined;
      if (c.eventCount !== lastCount) {
        lastCount = c.eventCount;
        stableAt = now();
      }
      if (!c.running && now() - stableAt > 1500) return c.eventCount;
      return undefined;
    },
    MAX_STEP_RUNTIME_MS,
    `agent idle`
  );
}

/** SSE 订阅:async generator 产出 {seq,item}。Delta 无 seq(seq=null)。abort 信号关闭流。 */
async function* sseStream(convId: string, lastSeq: number, signal: AbortSignal) {
  const resp = await fetch(`${BASE}/sse/${convId}?lastSeq=${lastSeq}`, {
    signal,
    headers: { accept: "text/event-stream" },
  });
  if (!resp.ok || !resp.body) throw new Error(`SSE 连接失败 status=${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const idM = frame.match(/^id: (\d+)/m);
        const dataLines = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6));
        if (dataLines.length) {
          let item: unknown;
          try {
            item = JSON.parse(dataLines.join("\n"));
          } catch {
            continue;
          }
          yield { seq: idM ? Number(idM[1]) : null, item: item as { type?: string } };
        }
      }
    }
  } catch {
    /* abort 关流,正常结束 */
  }
}

/** 直接读磁盘 events.jsonl(真相源)。脚本自己 parse,不耦合 ConversationStore。 */
function readDiskEvents(tinyhandsHome: string, convId: string): Array<{ type: string; seq: number; message?: string }> {
  // readConfig 把 TINYHANDS_HOME 解释为 home，再固定追加 workspace/。
  const f = join(tinyhandsHome, "workspace", convId, "events.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { type: string; seq: number; message?: string });
}

function logSection(t: string) {
  console.log(`\n=== ${t} ===`);
}

async function main() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "tinyhands-crash-verify-"));
  console.log(`临时 workspace: ${tmpRoot}`);
  console.log(`端口: ${PORT}  会话: ${CONV}`);

  const failures: string[] = [];
  let v1: ChildProcess | null = null;
  let v2: ChildProcess | null = null;
  let v1LogPath: string | null = null;
  let v2LogPath: string | null = null;
  let sseAc: AbortController | null = null;

  try {
    // ── 阶段 0:起服务 v1,健康检查 ──
    logSection("阶段0:启动服务 v1");
    const s1 = startService("v1", tmpRoot);
    v1 = s1.child;
    v1LogPath = s1.logPath;
    await waitForHealth("v1");
    console.log("  v1 /health 就绪");

    // ── 阶段 1:create + 发消息,真 agent 跑一轮(落盘) ──
    logSection("阶段1:create + 触发 agent 跑一轮");
    {
      const r = await post("/conversations/create", { conversationId: CONV, tools: ["run_bash"] });
      if (r.status !== 201) throw new Error(`create 失败 status=${r.status} body=${await r.text()}`);
      console.log("  create 201 ok");
    }
    {
      const r = await post("/conversations/send", {
        conversationId: CONV,
        text: "用 run_bash 执行 `echo hello_crash`,把输出告诉我,然后调用 finish 结束。",
      });
      if (r.status !== 200) throw new Error(`send 失败 status=${r.status} body=${await r.text()}`);
      console.log("  send ok,agent 后台跑一轮...");
    }
    const n1 = await waitForIdle(CONV);
    console.log(`  agent idle,事件数 N1=${n1}`);

    // ── 阶段 2:记录崩溃前磁盘真相 ──
    logSection("阶段2:记录崩溃前磁盘真相");
    const diskBefore = readDiskEvents(tmpRoot, CONV);
    const fpBefore = diskBefore.map((e) => `${e.seq}:${e.type}`);
    console.log(`  磁盘事件 ${diskBefore.length} 条:`);
    console.log("  " + fpBefore.join("  "));
    if (diskBefore.length === 0) throw new Error("崩溃前磁盘无事件,无法验证");
    const hasToolUse = diskBefore.some((e) => e.type === "tool_result");
    console.log(`  含 tool_use/tool_result 完整往返: ${hasToolUse ? "是" : "否(LLM 可能未配合,降级)"}`);
    const errEvt = diskBefore.find((e) => e.type === "error");
    if (errEvt) console.log(`  ⚠ error 事件内容: ${errEvt.message}`);

    // ── 阶段 3:真 kill -9 服务 v1(杀进程组,模拟进程级崩溃) ──
    logSection("阶段3:kill -9 服务 v1(模拟进程级崩溃)");
    try { process.kill(-v1.pid!, "SIGKILL"); } catch {
      try { v1.kill("SIGKILL"); } catch {}
    }
    await waitFor(() => !v1!.killed ? false : true, 5000, "v1 killed").catch(() => {});
    // 给 OS 一点时间回收端口
    await sleep(800);
    v1 = null;
    console.log("  v1 已被 SIGKILL(进程级崩溃),磁盘 events.jsonl 留在宿主机");

    // ── 阶段 4:重启服务 v2 ──
    logSection("阶段4:重启服务 v2");
    const s2 = startService("v2", tmpRoot);
    v2 = s2.child;
    v2LogPath = s2.logPath;
    await waitForHealth("v2");
    console.log("  v2 /health 就绪");

    // ── 阶段 5:SSE 订阅,验证历史补发 == 崩溃前磁盘 ──
    logSection("阶段5:SSE 订阅 v2,验证历史补发");
    sseAc = new AbortController();
    const collected: Array<{ seq: number | null; type?: string }> = [];
    const collectP = (async () => {
      for await (const e of sseStream(CONV, 0, sseAc!.signal)) {
        collected.push({ seq: e.seq, type: e.item.type });
      }
    })();

    // 等补发历史到齐:收齐 N1 条带 seq 的事件,且最后一条 seq === N1
    await waitFor(
      () => {
        const withSeq = collected.filter((c) => c.seq !== null);
        return withSeq.length >= diskBefore.length &&
          withSeq[withSeq.length - 1]?.seq === diskBefore.length
          ? withSeq
          : undefined;
      },
      10_000,
      "SSE 历史补发"
    );
    const backlog = collected.filter((c) => c.seq !== null);
    const fpAfter = backlog.map((e) => `${e.seq}:${e.type}`);
    console.log(`  SSE 补发历史 ${backlog.length} 条:`);
    console.log("  " + fpAfter.join("  "));
    const historyMatch = JSON.stringify(fpAfter) === JSON.stringify(fpBefore);
    if (historyMatch) {
      console.log("  ✓ 补发历史指纹与崩溃前磁盘完全一致");
    } else {
      failures.push("SSE 补发历史与崩溃前磁盘不一致");
      console.log("  ✗ 补发历史不一致");
    }

    // ── 阶段 6:续聊,验证续号 + agent 基于恢复历史继续 ──
    logSection("阶段6:续聊,验证续号(seq=N1+1) + agent 续跑");
    {
      const r = await post("/conversations/send", {
        conversationId: CONV,
        text: "再用一句话确认:你刚才执行的命令输出是什么?然后 finish。",
      });
      if (r.status !== 200) throw new Error(`续聊 send 失败 status=${r.status} body=${await r.text()}`);
      console.log("  续聊 send ok");
    }
    // 等续聊的 user_message 回显(seq 必须是 N1+1 —— 证明从恢复历史正确续号)
    try {
      await waitFor(
        () => {
          const um = collected.find((c) => c.seq === diskBefore.length + 1 && c.type === "user_message");
          return um ? um : undefined;
        },
        10_000,
        "续聊 user_message seq=N1+1"
      );
      console.log(`  ✓ 续聊 user_message seq=${diskBefore.length + 1}(从恢复历史正确续号,无空洞)`);
    } catch (e) {
      failures.push(`续聊未产生 seq=N1+1 的 user_message: ${(e as Error).message}`);
      console.log(`  ✗ 续聊未产生 seq=N1+1 的 user_message`);
    }
    // 等 agent 产生 seq>N1+1 的事件(证明 agent 用恢复的历史继续跑了,而非卡死)
    try {
      const after = await waitFor(
        () => {
          const e = collected.find((c) => c.seq !== null && c.seq! > diskBefore.length + 1);
          return e ? e : undefined;
        },
        LLM_FOLLOWUP_MS,
        "续聊后 agent 后续事件"
      );
      console.log(`  ✓ 续聊后 agent 产生 seq=${after.seq}(${after.type})事件 —— 恢复的历史可投影喂 LLM 未 400`);
    } catch (e) {
      failures.push(`续聊后 agent 无后续事件(LLM 不可达?): ${(e as Error).message}`);
      console.log(`  ✗ 续聊后 agent 无后续事件(LLM 可能不可达)`);
    }

    // ── 阶段 7:扫服务日志,确认无 400 / unhandled ──
    logSection("阶段7:扫描 v2 日志,确认无 LLM 400 / 未处理异常");
    const logText = readFileSync(s2.logPath, "utf8");
    const badPatterns = [
      /400/,
      /invalid_request_error/,
      /tool_use.*tool_result/i,
      /unhandled/i,
      /Unhandled/,
    ];
    const badLines = logText.split("\n").filter((l) => badPatterns.some((p) => p.test(l)));
    if (badLines.length === 0) {
      console.log("  ✓ 日志无 400 / invalid_request / unhandled 痕迹");
    } else {
      console.log(`  ⚠ 日志命中可疑行 ${badLines.length} 条(前 5):`);
      badLines.slice(0, 5).forEach((l) => console.log("    " + l.slice(0, 200)));
      // 不直接判失败:有些无关 400(如端口)。只有 invalid_request/unhandled 才算硬失败
      const hard = badLines.filter((l) => /invalid_request_error|unhandled|Unhandled/.test(l));
      if (hard.length) failures.push(`日志含硬错误: ${hard.length} 条`);
    }

    // 收尾 SSE
    sseAc?.abort();
    await collectP.catch(() => {});
    sseAc = null;
  } finally {
    if (sseAc) sseAc.abort();
    // 诊断:报告每个服务进程的退出码;非 0 退出时打印日志尾部 + 保留 tmpRoot 供排查
    let anyAbnormal = false;
    for (const [tag, c, lp] of [
      ["v1", v1, v1LogPath],
      ["v2", v2, v2LogPath],
    ] as const) {
      if (!c) continue;
      const ec = c.exitCode;
      const sig = c.signalCode;
      if (ec !== null && ec !== 0) {
        anyAbnormal = true;
        console.log(`  [diag] ${tag} 异常退出 exitCode=${ec} signal=${sig}`);
        if (lp) {
          try {
            const tail = readFileSync(lp, "utf8").split("\n").slice(-40).join("\n");
            console.log(`  [diag] ${tag} 日志尾部:\n${tail}`);
          } catch {}
        }
      }
      if (!c.killed) {
        // 杀整个进程组(-pid),覆盖 node --import tsx 单进程 + 任何孙进程,不留孤儿
        try { process.kill(-c.pid!, "SIGKILL"); } catch {
          try { c.kill("SIGKILL"); } catch {}
        }
      }
    }
    if (anyAbnormal) {
      console.log(`  [diag] 保留临时目录供排查: ${tmpRoot}`);
    } else {
      try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    }
  }

  // ── 结论 ──
  logSection("验证结论");
  if (failures.length === 0) {
    console.log("✓ PASS —— 真进程级 kill -9 后,同 id 会话历史完整恢复、续号正确、agent 可基于恢复历史继续。");
    console.log("  §5「OS 兜底刷盘不丢」假设 + §6 验收1 在真实进程级崩溃下成立。");
    process.exit(0);
  } else {
    console.log(`✗ FAIL —— ${failures.length} 项未过:`);
    failures.forEach((f) => console.log("  - " + f));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("验证脚本异常:", err);
  process.exit(2);
});
