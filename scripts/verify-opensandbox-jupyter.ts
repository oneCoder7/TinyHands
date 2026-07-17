/**
 * OpenSandbox 原生 Jupyter kernel 端到端验证脚本(批次四)。
 *
 * 直接驱动 OpenSandboxRuntime.runCode,不经过 server/agent 栈,聚焦验证:
 *   ① 表达式返回值 result(exec 兜底拿不到的东西)
 *   ② matplotlib 图片 images(base64 PNG)
 *   ③ 有状态 kernel(变量跨 runCode 调用保留)
 *   ④ 结构化错误 error
 *
 * 前置:本地 OpenSandbox server(localhost:8080)已起、code-interpreter 镜像已拉。
 * 运行:npx tsx scripts/verify-opensandbox-jupyter.ts
 */
import { OpenSandboxRuntime } from "../packages/server/src/runtime/opensandbox-runtime.js";

function line(title: string) {
  console.log("\n" + "═".repeat(60) + "\n" + title + "\n" + "═".repeat(60));
}

async function main() {
  const rt = new OpenSandboxRuntime({
    serverUrl: process.env.OPENSANDBOX_SERVER_URL ?? "http://127.0.0.1:18080",
    apiKey: process.env.OPENSANDBOX_API_KEY || undefined,
    image: process.env.OPENSANDBOX_IMAGE ?? "opensandbox/code-interpreter:v1.1.0",
  });

  line("创建沙箱");
  await rt.create();
  console.log("✅ 沙箱已就绪");

  // ⚠️ 本地 docker runtime 缺口:execd bootstrap 顶替了镜像 entrypoint,
  // jupyter 不会自启。手动拉起镜像自带的 code-interpreter.sh,等 44771 就绪。
  line("启动 Jupyter 服务(本地部署需手动拉起)");
  await rt.exec(
    "nohup /opt/code-interpreter/code-interpreter.sh > /opt/code-interpreter/entry.log 2>&1 & echo started",
    { timeoutMs: 15_000 }
  );
  let jupyterReady = false;
  for (let i = 0; i < 40; i++) {
    const probe = await rt.exec(
      "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:44771/api 2>/dev/null || echo 000",
      { timeoutMs: 20_000 }
    );
    if (probe.stdout.trim() === "200") {
      jupyterReady = true;
      break;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  console.log(jupyterReady ? "✅ Jupyter 已就绪(44771)" : "❌ Jupyter 未就绪(后续必失败)");

  // matplotlib 预装:必须走 exec(commands.run 普通 HTTP),不能走 runCode 的 SSE 通道。
  // arm64 首次装 matplotlib(含 numpy 编译)耗时数分钟,压在 SSE 长连接上会 fetch failed 并打挂 kernel。
  // kernel python 是 uv 托管的 externally-managed 环境(PEP 668),需 --break-system-packages。
  line("预装 matplotlib(走 exec 通道,避免拖垮 SSE)");
  const rInstall = await rt.exec(
    "for p in /opt/python/versions/cpython-3.14*/bin/python3; do \"$p\" -m pip install -q --break-system-packages matplotlib && echo INSTALL_OK; done",
    { timeoutMs: 300_000 }
  );
  console.log("pip install:", rInstall.stdout.includes("INSTALL_OK") ? "✅ 成功" : "⚠️ 未见 INSTALL_OK", rInstall.stderr.slice(-200));

  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean, detail?: string) => {
    if (cond) {
      pass++;
      console.log(`✅ ${name}`);
    } else {
      fail++;
      console.log(`❌ ${name}${detail ? "  ← " + detail : ""}`);
    }
  };

  try {
    // ① 表达式返回值
    line("① 表达式返回值 result");
    const r1 = await rt.runCode("21 * 2");
    console.log(JSON.stringify(r1, (k, v) =>
      k === "images" ? (v as string[]).map((s) => s.slice(0, 20) + "...(" + s.length + ")") : v, 2));
    check("表达式 21*2 返回值进 result", r1.result === "42", `result=${r1.result}`);
    check("表达式无 error", !r1.error, r1.error);

    // ② 有状态 kernel:先定义变量,下一次调用能读到
    line("② 有状态 kernel(变量跨调用保留)");
    await rt.runCode("x = 100");
    const r2 = await rt.runCode("x + 1");
    console.log("x+1 →", r2.result);
    check("跨 runCode 变量保留(x=100 → x+1=101)", r2.result === "101", `result=${r2.result}`);

    // ③ stdout 捕获
    line("③ stdout 捕获");
    const r3 = await rt.runCode("print('hello from jupyter')");
    console.log("stdout:", JSON.stringify(r3.stdout));
    check("print 输出进 stdout", r3.stdout.includes("hello from jupyter"), r3.stdout);

    // ④ matplotlib 图片(matplotlib 已在前面走 exec 预装)
    line("④ matplotlib 图片 images(base64 PNG)");
    // Jupyter 富输出:必须 %matplotlib inline + 最后一行返回 figure 对象让 IPython rich-display,
    // 才会产生 image/png。Agg + plt.show() 不产生任何富输出(采集器只认 inline backend)。
    const r4 = await rt.runCode(
      [
        "%matplotlib inline",
        "import matplotlib.pyplot as plt",
        "fig, ax = plt.subplots()",
        "ax.plot([1, 2, 3], [1, 4, 9])",
        "ax.set_title('e2e test')",
        "fig",
      ].join("\n")
    );
    console.log("images 数量:", r4.images.length);
    if (r4.images.length > 0) {
      const img = r4.images[0]!;
      console.log("第一张图 base64 前 30 字符:", img.slice(0, 30));
      console.log("base64 长度:", img.length);
      // PNG base64 以 iVBORw0KGgo 开头
      check("图片是 PNG(base64 以 iVBORw0KGgo 开头)", img.startsWith("iVBORw0KGgo"), img.slice(0, 20));
    }
    check("matplotlib 图片进 images", r4.images.length > 0, `images.length=${r4.images.length}, error=${r4.error ?? "none"}`);

    // ⑤ 结构化错误
    line("⑤ 结构化错误 error");
    const r5 = await rt.runCode("undefined_variable_xyz");
    console.log("error:", r5.error);
    check("NameError 进 error 字段", Boolean(r5.error && r5.error.includes("NameError")), r5.error);

    line(`结果:${pass} 通过 / ${fail} 失败`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    line("销毁沙箱");
    await rt.kill();
    console.log("✅ 已销毁");
  }
}

main().catch((err) => {
  console.error("验证脚本异常:", err);
  process.exitCode = 1;
});
