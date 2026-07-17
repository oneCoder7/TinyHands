# Tinyhands

**一个完整的 agent runtime。**

简体中文 | [English](README.en.md)

Tinyhands 是一个多会话 agent 运行时。当前仓库可作为独立服务启动,通过 HTTP 创建
会话、发送消息,agent 便会在一个可隔离的执行环境里自主地读写文件、跑命令、
执行代码、操作浏览器,直到完成任务——整个过程以事件流的形式实时推送出来。

仓库已拆成 `@tinyhands/protocol`、`@tinyhands/server`、`@tinyhands/sdk` 与
standalone npm workspaces，并提供独立 package exports。它们尚未发布到公共 npm
registry；当前可在本 workspace 或通过 `npm pack` 产物集成，禁止深度导入包内 `src/`。

它是构建 agent 应用(编程助手、数据分析、自动化任务……)的地基,免去了从零
搭建「LLM 循环 + 工具调用 + 执行沙箱 + 会话管理 + 实时推流」这一整套的成本。

## 能做什么

- **多会话并发**——单进程托管任意多个相互隔离的会话,各有独立的工作目录和执行环境,互不干扰。
- **自主工具循环**——内置 ReAct 循环:agent 自行决定调用哪个工具、看到结果后再决定下一步,直到调用 `finish` 收尾。
- **可插拔执行环境**——同一套代码,一个环境变量即可在「本机直跑 / Docker 隔离 / OpenSandbox 云沙箱」之间切换。
- **实时事件流**——每一步(思考、发言、工具调用、执行结果)都作为事件推送给订阅方,支持断线重连补发。
- **会话可恢复**——事件流落盘,进程重启后按同一会话 id 即可找回历史、续聊,不丢上下文。
- **持久化执行追踪**——每次 HTTP trigger、Agent run、LLM 调用和 Tool 执行通过稳定 ID 关联,可在进程重启后回溯。
- **协作式打断**——运行中随时可打断,agent 在检查点干净地停下,不留半截状态。
- **自动上下文压缩**——默认按 20k 上下文窗口自动生成可恢复 checkpoint，原始事件永不删除。
- **流式输出**——支持 token 级流式,包括 extended thinking 的思考过程实时呈现。

## 快速开始

```bash
npm install

# 配置:复制模板,填入 provider/model 和 API key；兼容网关再设置地址与协议
cp .env.example .env
$EDITOR .env

npm run serve        # 默认监听 :8787
```

服务启动时零会话,一切按需创建。下面是一次完整的交互:

```bash
# 1) 创建会话,启用 shell 和代码执行工具
curl -XPOST localhost:8787/v1/conversations \
  -H 'content-type: application/json' \
  -d '{"conversationId":"demo","tools":["run_bash","run_code"]}'

# 2) 订阅它的事件流(另开一个终端,保持连接)
curl -N localhost:8787/v1/conversations/demo/events

# 3) 发一条消息,观察第 2 步的终端实时吐出 agent 的思考、工具调用与结果
curl -XPOST localhost:8787/v1/conversations/demo/messages \
  -H 'content-type: application/json' \
  -d '{"text":"统计当前目录有多少个文件,写进 count.txt"}'
```

## 集成方式

典型的接入模式是:**上行发命令走 REST,下行看结果订阅事件流**。

远程 Node.js 调用者可使用 `@tinyhands/sdk`；它只依赖公开 protocol，不依赖 server
实现。当前 package 尚未发布到公共 registry，下面示例适用于 workspace 或 tarball
安装后的消费者：

```ts
import { TinyhandsClient } from "@tinyhands/sdk";

const client = new TinyhandsClient({
  baseUrl: "http://localhost:8787",
  headers: () => ({ authorization: `Bearer ${getAccessToken()}` }),
});

const conversation = await client.conversations.create({ tools: ["run_bash"] });
for await (const item of conversation.events()) {
  // 持久事件自动以 Last-Event-ID 断线续传；delta 不推进重连锚点
  console.log(item);
}
```

上层 Node.js Backend 也可以直接嵌入 `@tinyhands/server`，不需要使用 Fastify，
也不需要 clone 或修改 Tinyhands 源码：

```ts
import { createTinyhandsHost } from "@tinyhands/server";
import { createTinyhandsFetchHandler } from "@tinyhands/server/http";

const host = await createTinyhandsHost({
  workspaceRoot: "/var/lib/my-app/tinyhands",
  maxStep: 10,
  llm: {
    provider: "openai",
    apiKey: process.env.MY_LLM_KEY!,
    baseURL: "https://api.openai.com/v1",
    model: "your-model",
    maxTokens: 8192,
    apiMode: "responses",
    autoCompact: {
      enabled: true,
      contextWindow: 20_000,
      triggerRatio: 0.8,
      targetRatio: 0.5,
    },
  },
  runtime: { type: "local" },
});

// 直接调用应用端口
const conversation = await host.conversations.create({ tools: ["run_bash"] });
await host.conversations.send(conversation.conversationId, "分析当前目录");

// 或把任意框架收到的 WHATWG Request 交给版本化 /v1 handler
const handleTinyhands = createTinyhandsFetchHandler({ host });
const response = await handleTinyhands(request);

await host.close();
```

`@tinyhands/server` 只公开根入口和 `@tinyhands/server/http`。环境变量解析、Pino
实例、端口监听与进程信号属于 standalone；嵌入方继续使用自己应用的配置、日志、
鉴权和 Server framework。可通过 `logger` 传入结构兼容 Pino 的应用 logger；省略
时 Server 保持静默。Runtime 使用判别联合，只需提供当前类型所需配置。

### 1. 创建会话

`POST /v1/conversations`,可选传 `conversationId`(不传则自动生成)和
`tools`(要启用的可选工具)。每个会话对应一个独立的工作目录和执行环境。

### 2. 订阅事件流

用 SSE `GET /v1/conversations/:id/events` 订阅。它是只读观察窗口——agent 是否
在运行,与有没有人在看**完全无关**;没有订阅者时后台照跑,新订阅者接入时会先
补发历史事件,再转入实时。WebSocket 目前仅由 legacy 接口提供。

重连时发送 `Last-Event-ID: N` 即可只补发序号 `N` 之后的持久事件；也兼容
`?afterSeq=N`。瞬态 `delta` 没有事件 id,不会推进重连锚点。

订阅方会收到这些事件(每条带单调递增的 `seq`):

| 事件类型            | 含义                                        |
| ------------------- | ------------------------------------------- |
| `user_message`      | 用户消息(发出的消息会回显给所有订阅者)    |
| `thinking_finished` | 一段思考定稿(extended thinking)           |
| `agent_message`     | agent 的发言 + 它发起的工具调用             |
| `tool_result`       | 某次工具调用的执行结果                      |
| `finished`          | 任务完成(agent 调用了 `finish`)          |
| `interrupted`       | 本轮 run 被打断                             |
| `error`             | 运行出错                                    |
| `compaction_started` | 上下文压缩开始，可通过 interrupt 中断       |
| `compaction_completed` | 上下文压缩 checkpoint 已提交              |
| `compaction_cancelled` | 上下文压缩被用户中断或进程重启取消         |
| `compaction_failed` | 上下文压缩失败，只包含稳定错误码             |

外加瞬态的 `delta`(流式 token / 思考增量),只广播、不入历史。
内部 `compacted` checkpoint 会持久化，但不会通过 WS/SSE 暴露。

### 3. 发消息 / 打断

`POST /v1/conversations/:id/messages` 发消息触发一轮 run；
`POST /v1/conversations/:id/interrupt` 协作式打断进行中的 run。接口都是即时
受理确认,真正的进展从事件流里看。

`send` 成功后会返回持久化的 `triggerId`：

```json
{
  "accepted": true,
  "running": true,
  "triggerId": "550e8400-e29b-41d4-a716-446655440000"
}
```

同一 Agent step 可以消费多个并发到达的 trigger；它们与 run、LLM、Tool 的真实
归属关系记录在该会话的 `run_log.jsonl` 中。

完整接口见 [HTTP API](#http-api)。

### 4. 持久化数据

每个会话的数据默认保存在 `~/workspace/<conversationId>/`；开发和测试可用
`TINYHANDS_HOME` 覆盖 `~`：

```text
~/workspace/<conversationId>/
├── meta.json
├── events.jsonl
└── run_log.jsonl
```

- `events.jsonl` 是对话真相源，保存用户消息、Agent/Tool 结果和压缩 checkpoint。
- `run_log.jsonl` 保存 run、step、LLM、Tool 的生命周期、耗时和 provider 上报的
  token usage，但不重复保存 prompt、回复、工具参数或工具结果正文。
- 删除会话时会删除整个会话目录。

Tinyhands 当前不提供 `/stats`、`/metrics` 或 Run Log 查询 API；需要回溯时直接消费
持久化 JSONL，后续应根据真实查询需求再设计 read model。

## 设计亮点

这些设计决定了它好扩展、好嵌入:

- **事件流是唯一真相源,且已持久化。** 会话状态就是一条只追加的事件日志;喂给 LLM 的
  上下文是这条日志的纯投影。事件流落盘后,进程重启即可按会话 id 恢复历史、续聊。
  这意味着会话天然可审计、可回放——时间旅行调试只需消费这一条流。
- **Runtime ≠ Sandbox,执行位置可插拔。** 工具只表达意图(「跑这条命令」),
  在哪跑由 `Runtime` 决定。本机、Docker、云沙箱共用一套工具代码,切换零改动。
- **对厂商中性。** 整个内核只认一组中性 LLM 类型,只有 provider adapter 会接触
  厂商 SDK 类型。换模型、换 provider 不会渗透到业务代码。
- **传输与执行解耦。** WS/SSE 只是观察窗口,插拔订阅者不影响 agent 运行,
  也让「加一种下行通道」变得廉价。

## 源码扩展（仅 fork / 贡献开发）

Tinyhands 当前还没有面向外部应用的自定义 Tool、Runtime 或 LLM provider 注册 API。
正式发行版的接入者不应修改 Tinyhands 内部代码；下面的入口只用于 fork 本项目或向
本仓库贡献内置实现,不是稳定的公共扩展合同。公共 Tool 扩展机制将在真实隔离、权限和
生命周期需求明确后单独设计。

**加一个工具。** 实现 `Tool` 接口(`name` / `description` / Zod `schema` /
`execute`),在 `packages/server/src/tools/catalog.ts` 的目录里登记一行即可。工具通过
`ctx.runtime` 执行,因此天然跨所有执行环境可用。

```ts
export const myTool: Tool<MyArgs> = {
  name: "my_tool",
  description: "给 LLM 看的说明,影响它何时选择这个工具",
  schema: MyArgs,                       // zod/v4
  async execute(args, ctx) {
    const r = await ctx.runtime.exec(`...`);
    return { content: r.stdout, isError: r.exitCode !== 0 };
  },
};
```

**换一种执行环境。** 实现 `Runtime` 接口(`exec` / `readFile` / `writeFile` /
`runCode` / `runBrowser` + `create`/`kill` 生命周期),即可接入任意沙箱后端。
内置 `Local` / `Docker` / `OpenSandbox` 三种可直接参考。

**接一个新的 LLM provider。** 实现 `LLMClient` 接口(核心就一个 `chat` 方法,
只用中性类型收发),在 `packages/server/src/llm/factory.ts` 加一个 `case`。Agent 与装配层
零改动,因为它们只依赖接口。

## 未来方向

- 发布 protocol、server 与 SDK npm packages
- 设计无需修改 Tinyhands 源码的外部 Tool 扩展合同
- 更多内置工具(网络搜索、文件编辑补丁、子任务派生)
- `redacted_thinking` 块的完整处理(当前为已知缺口)
- 更多 provider 实现
- 更细粒度的资源配额(每会话的执行超时、预算上限)

## HTTP API

新集成只使用版本化 `/v1` REST + SSE：

| 方法   | 路径                                           | 用途                |
| ------ | ---------------------------------------------- | ------------------- |
| POST   | `/v1/conversations`                            | 创建会话            |
| GET    | `/v1/conversations`                            | 列出会话            |
| DELETE | `/v1/conversations/:conversationId`            | 删除会话            |
| POST   | `/v1/conversations/:conversationId/messages`   | 提交一条用户消息    |
| POST   | `/v1/conversations/:conversationId/interrupt`  | 协作式打断 run      |
| GET    | `/v1/conversations/:conversationId/events`     | SSE 下行事件流      |

`/v1` 的错误体为 `{ "error": { "code", "message" } }`。SSE 支持
`Last-Event-ID` 断线续传；鉴权可由上层 adapter 在进入 Host 前完成。

旧 `/conversations/*`、`/sse/:id` 和 `/ws/:id` 仍由 standalone 提供兼容，但只做
legacy 维护，不再承载新能力。`GET /health` 仍作为 standalone 存活探针。

## 配置

以下环境变量只由 standalone 启动器读取一次(见 `.env.example`)。直接嵌入
`@tinyhands/server` 时应把显式 `TinyhandsHostOptions` 交给 `createTinyhandsHost()`，
Server library 本身不会读取环境变量。

| 变量                    | 默认值                               | 说明                                     |
| ----------------------- | ------------------------------------ | ---------------------------------------- |
| `LLM_MODEL`             | —                                    | 必填，`provider/model`，如 `openai/gpt-5` |
| `LLM_API_KEY`           | —                                    | API key 统一入口；也可只设置对应 provider 的兼容别名 |
| `LLM_BASE_URL`          | 官方 provider endpoint               | 私有或兼容网关地址                        |
| `LLM_OPENAI_API_MODE`   | `responses`                          | 仅 `openai/*`：`responses` \| `chat_completions` |
| `PORT`                  | `8787`                               |                                          |
| `TINYHANDS_HOME`        | `~`                                  | 覆盖家目录；workspace → `$TINYHANDS_HOME/workspace`。仅开发/测试用 |
| `LLM_MAX_TOKENS`        | `8192`                               |                                          |
| `LLM_THINKING_BUDGET`   | `2048`                               | 仅 `anthropic/*`；`0` 表示关闭 extended thinking |
| `LLM_AUTO_COMPACT_ENABLED` | `true`                             | 是否自动压缩上下文                         |
| `LLM_CONTEXT_WINDOW`    | `20000`                              | 模型总上下文窗口，可按部署模型覆盖           |
| `LLM_AUTO_COMPACT_TRIGGER_RATIO` | `0.80`                    | 相对可用输入预算的触发比例                   |
| `LLM_AUTO_COMPACT_TARGET_RATIO` | `0.50`                     | 压缩后目标比例，必须小于触发比例              |
| `MAX_STEP`              | `10`                                 | agent 循环上限                           |
| `RUNTIME`               | `local`                              | `local` \| `docker` \| `opensandbox`     |
| `DOCKER_IMAGE`          | `tinyhands-sandbox:latest`           | 当 `RUNTIME=docker` 时                    |
| `OPENSANDBOX_SERVER_URL`| `http://localhost:8080`              | 当 `RUNTIME=opensandbox` 时              |
| `OPENSANDBOX_IMAGE`     | `opensandbox/code-interpreter:v1.1.0`| code-interpreter 镜像(内置 Jupyter)    |

当前支持 `anthropic/*` 和 `openai/*`。`LLM_MODEL` 只按第一个 `/` 拆分，因此模型名
本身可以继续包含 `/`。常见配置如下：

```env
# Anthropic 官方接口
LLM_MODEL=anthropic/your-model
LLM_API_KEY=your-token

# OpenAI Responses（openai/* 的默认协议）
LLM_MODEL=openai/your-model
LLM_API_KEY=your-token

# OpenAI-compatible Chat Completions 网关
LLM_MODEL=openai/your-model
LLM_API_KEY=your-token
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_OPENAI_API_MODE=chat_completions
```

Responses 与 Chat Completions 不会在请求失败后自动互相降级，兼容网关必须显式选择
其实际支持的协议。

升级旧配置时，把 `LLM_PROVIDER=openai` + `LLM_MODEL=gpt-x` 合并为
`LLM_MODEL=openai/gpt-x`；`LLM_PROVIDER` 已移除。

## 内置工具

始终可用:`read_file`、`write_file`、`finish`。可选(创建会话时经 `tools`
字段开启):`run_bash`、`run_code`、`browser`。其中 `run_code`(带富输出的
Jupyter kernel)与 `browser`(Playwright)需要能提供它们的 runtime——
Docker 或 OpenSandbox。

## 开发

```text
packages/
├── protocol/       # 版本化 DTO、公开事件和稳定错误码；零 server 依赖
├── server/         # TinyhandsHost、Fetch handler、Agent/Runtime 内核
└── sdk/            # 远程 TinyhandsClient；只依赖 protocol
apps/
└── standalone/     # Fastify、legacy 路由、env、listen 与 signal
```

```bash
npm run typecheck    # 构建各 package，并检查源码、测试与 smoke scripts
npm test             # vitest run
```

以下命令使用 `.env` 中的真实 provider，会产生真实 token 消耗，不进入常规 CI：

```bash
npm run verify:provider  # streaming、同轮多工具、结果回传、重建 client、interrupt
npm run verify:compact   # 压缩中断、新 query 重压缩、checkpoint 与磁盘恢复
npm run verify:crash     # 启动服务、SIGKILL、重启、SSE 补发与续聊
```

真实验收必须按协议分别判断。当前项目已在 OpenAI-compatible Chat Completions 端点
跑通上述 smoke；Responses adapter 已通过协议级自动化测试，但仍需可用的真实
Responses endpoint 才能声称真实集成验证通过。

纯 ESM + TypeScript,用 `tsx` 直接运行。
