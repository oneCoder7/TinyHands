/**
 * tinyhands-execd —— 容器内执行服务。
 *
 * 执行协议的 server 端:DockerRuntime(及未来 RemoteRuntime)容器内都跑这同一个
 * server,差异只在容器怎么 provision。全 POST,4 端点:
 *   /exec 执行命令 {stdout,stderr,exitCode} · /read-file {content}
 *   /write-file {ok:true} · /health {status:"ok"}
 *
 * 零依赖:只用 node:http / child_process / fs / path。纯 JS:不参与宿主 tsconfig,
 * 单文件 COPY 进 Dockerfile。
 */

"use strict";

const http = require("node:http");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = 44772;
const WORKSPACE = "/workspace";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1024 * 1024; // 1MB,与 LocalRuntime 一致

// ---- 路径安全 ----

/**
 * 解析路径并做遍历防护:resolve 后必须落在 /workspace 内,否则返回 null。
 * 防 ../../etc/passwd 之类路径穿越。
 */
function safePath(inputPath) {
  if (!inputPath || typeof inputPath !== "string") return null;
  const resolved = path.resolve(WORKSPACE, inputPath);
  if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + path.sep)) {
    return null;
  }
  return resolved;
}

// ---- 请求体解析 ----

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BUFFER) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function parseJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

// ---- 响应工具 ----

function json(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ---- 端点实现 ----

/**
 * POST /exec — 执行 bash -c command
 * 请求 {"command":"...","timeoutMs":30000}
 * 响应 {"stdout":"...","stderr":"...","exitCode":0}
 */
async function handleExec(req, res) {
  const body = await parseJson(req);
  const command = body.command;
  if (!command || typeof command !== "string") {
    return json(res, 400, { error: "missing command" });
  }
  const timeoutMs =
    typeof body.timeoutMs === "number" && body.timeoutMs > 0
      ? body.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  try {
    const result = await new Promise((resolve) => {
      const proc = execFile(
        "bash",
        ["-c", command],
        {
          cwd: WORKSPACE,
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER,
        },
        (err, stdout, stderr) => {
          if (err) {
            resolve({
              stdout: stdout ?? "",
              stderr: stderr ?? err.message,
              exitCode: typeof err.code === "number" ? err.code : 1,
            });
          } else {
            resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode: 0 });
          }
        }
      );
    });
    json(res, 200, result);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/**
 * POST /read-file — 读文件
 * 请求 {"path":"relative/path"}
 * 响应 {"content":"..."} 或 404 {"error":"..."}
 */
async function handleReadFile(req, res) {
  const body = await parseJson(req);
  const resolved = safePath(body.path);
  if (!resolved) {
    return json(res, 403, { error: "path traversal denied" });
  }
  try {
    const content = await fs.readFile(resolved, "utf-8");
    json(res, 200, { content });
  } catch (err) {
    if (err.code === "ENOENT") {
      json(res, 404, { error: `file not found: ${body.path}` });
    } else {
      json(res, 500, { error: err.message });
    }
  }
}

/**
 * POST /write-file — 覆盖写文件
 * 请求 {"path":"relative/path","content":"..."}
 * 响应 {"ok":true}
 */
async function handleWriteFile(req, res) {
  const body = await parseJson(req);
  const resolved = safePath(body.path);
  if (!resolved) {
    return json(res, 403, { error: "path traversal denied" });
  }
  if (typeof body.content !== "string") {
    return json(res, 400, { error: "missing content" });
  }
  try {
    // 目录不存在自动创建
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, body.content, "utf-8");
    json(res, 200, { ok: true });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

/** POST /health — 就绪探针 */
function handleHealth(_req, res) {
  json(res, 200, { status: "ok" });
}

// ---- HTTP server ----

const server = http.createServer(async (req, res) => {
  // 全 POST,非 POST 一律 405
  if (req.method !== "POST") {
    return json(res, 405, { error: "method not allowed, use POST" });
  }

  try {
    switch (req.url) {
      case "/exec":
        return await handleExec(req, res);
      case "/read-file":
        return await handleReadFile(req, res);
      case "/write-file":
        return await handleWriteFile(req, res);
      case "/health":
        return handleHealth(req, res);
      default:
        return json(res, 404, { error: `unknown endpoint: ${req.url}` });
    }
  } catch (err) {
    // 顶层兜底:解析失败/意外异常不让 server crash
    if (!res.headersSent) {
      json(res, 500, { error: err.message ?? "internal error" });
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`execd ready on ${PORT}`);
});
