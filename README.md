# Tinyhands

**一个完整的 agent runtime。**

简体中文 | [English](README.en.md)

Tinyhands 是一个可嵌入的多会话 agent 运行时。作为服务启动后,通过 HTTP 创建
会话、发送消息,agent 便会在一个可隔离的执行环境里自主地读写文件、跑命令、
执行代码、操作浏览器,直到完成任务——整个过程以事件流的形式实时推送出来。

它是构建 agent 应用(编程助手、数据分析、自动化任务……)的地基,免去了从零
搭建「LLM 循环 + 工具调用 + 执行沙箱 + 会话管理 + 实时推流」这一整套的成本。

## 能做什么

- **多会话并发**——单进程托管任意多个相互隔离的会话,各有独立的工作目录和执行环境,互不干扰。
- **自主工具循环**——内置 ReAct 循环:agent 自行决定调用哪个工具、看到结果后再决定下一步,直到调用 `finish` 收尾。
- **可插拔执行环境**——同一套代码,一个环境变量即可在「本机直跑 / Docker 隔离 / OpenSandbox 云沙箱」之间切换。
- **实时事件流**——每一步(思考、发言、工具调用、执行结果)都作为事件推送给订阅方,支持断线重连补发。
- **会话可恢复**——事件流落盘,进程重启后按同一会话 id 即可找回历史、续聊,不丢上下文。
- **协作式打断**——运行中随时可打断,agent 在检查点干净地停下,不留半截状态。
- **流式输出**——支持 token 级流式,包括 extended thinking 的思考过程实时呈现。

## 快速开始

```bash
npm install

# 配置:复制模板,填入网关地址、模型名和 token
cp .env.example .env
$EDITOR .env

npm run serve        # 默认监听 :8787
```

服务启动时零会话,一切按需创建。下面是一次完整的交互:

```bash
# 1) 创建会话,启用 shell 和代码执行工具
curl -XPOST localhost:8787/conversations/create \
  -d '{"conversationId":"demo","tools":["run_bash","run_code"]}'

# 2) 订阅它的事件流(另开一个终端,保持连接)
curl -N localhost:8787/sse/demo

# 3) 发一条消息,观察第 2 步的终端实时吐出 agent 的思考、工具调用与结果
curl -XPOST localhost:8787/conversations/send \
  -d '{"conversationId":"demo","text":"统计当前目录有多少个文件,写进 count.txt"}'
```

## 集成方式

典型的接入模式是:**上行发命令走 REST,下行看结果订阅事件流**。

### 1. 创建会话

`POST /conversations/create`,可选传 `conversationId`(不传则自动生成)和
`tools`(要启用的可选工具)。每个会话对应一个独立的工作目录和执行环境。

### 2. 订阅事件流

用 WebSocket(`/ws/:id`)或 SSE(`/sse/:id`)订阅。两者是对等的只读观察窗口
——agent 是否在运行,与有没有人在看**完全无关**;没有订阅者时后台照跑,
新订阅者接入时会先补发历史事件,再转入实时。

带 `?lastSeq=N` 参数即可在重连时只补发序号 `N` 之后的事件,不丢不重。

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

外加瞬态的 `delta`(流式 token / 思考增量),只广播、不入历史。

### 3. 发消息 / 打断

`POST /conversations/send` 发消息触发一轮 run;`POST /conversations/interrupt`
协作式打断进行中的 run。接口都是即时受理确认,真正的进展从事件流里看。

完整接口见 [HTTP API](#http-api)。

## 设计亮点

这些设计决定了它好扩展、好嵌入:

- **事件流是唯一真相源,且已持久化。** 会话状态就是一条只追加的事件日志;喂给 LLM 的
  上下文是这条日志的纯投影。事件流落盘后,进程重启即可按会话 id 恢复历史、续聊。
  这意味着会话天然可审计、可回放——时间旅行调试只需消费这一条流。
- **Runtime ≠ Sandbox,执行位置可插拔。** 工具只表达意图(「跑这条命令」),
  在哪跑由 `Runtime` 决定。本机、Docker、云沙箱共用一套工具代码,切换零改动。
- **对厂商中性。** 整个内核只认一组中性 LLM 类型,只有一个文件真正 import
  Anthropic SDK。换模型、换 provider 不会渗透到业务代码。
- **传输与执行解耦。** WS/SSE 只是观察窗口,插拔订阅者不影响 agent 运行,
  也让「加一种下行通道」变得廉价。

## 扩展

三个最常见的扩展点,都遵循开闭原则——加新东西,不改老代码:

**加一个工具。** 实现 `Tool` 接口(`name` / `description` / Zod `schema` /
`execute`),在 `src/tools/catalog.ts` 的目录里登记一行即可。工具通过
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
只用中性类型收发),在 `src/llm/factory.ts` 加一个 `case`。Agent 与装配层
零改动,因为它们只依赖接口。

## 未来方向

- 更多内置工具(网络搜索、文件编辑补丁、子任务派生)
- `redacted_thinking` 块的完整处理(当前为已知缺口)
- 更多 provider 实现(原生 OpenAI 协议等)
- 更细粒度的资源配额(每会话的执行超时、预算上限)

## HTTP API

所有命令类接口均为 `POST` + JSON body。

| 方法   | 路径                        | 用途                      |
| ------ | --------------------------- | ------------------------- |
| GET    | `/health`                   | 存活探针 / 会话数         |
| POST   | `/conversations/create`     | 创建会话                  |
| POST   | `/conversations/list`       | 列出会话                  |
| POST   | `/conversations/delete`     | 销毁会话                  |
| POST   | `/conversations/send`       | 提交一条用户消息          |
| POST   | `/conversations/interrupt`  | 协作式打断进行中的 run    |
| WS     | `/ws/:conversationId`       | 下行事件流                |
| SSE    | `/sse/:conversationId`      | 下行事件流                |

## 配置

所有配置在启动时从环境变量读取一次(见 `.env.example`)。

| 变量                    | 默认值                               | 说明                                     |
| ----------------------- | ------------------------------------ | ---------------------------------------- |
| `ANTHROPIC_AUTH_TOKEN`  | —                                    | 必填(或用 `LLM_API_KEY`)               |
| `LLM_BASE_URL`          | —                                    | 必填 —— Anthropic 风格网关地址           |
| `LLM_MODEL`             | —                                    | 必填 —— 模型名                           |
| `PORT`                  | `8787`                               |                                          |
| `TINYHANDS_HOME`        | `~`(即 `~/workspace`)              | 覆盖家目录;workspace → `$TINYHANDS_HOME/workspace`。仅开发/测试用,默认零配置 |
| `LLM_MAX_TOKENS`        | `8192`                               |                                          |
| `LLM_THINKING_BUDGET`   | `2048`                               | `0` 表示关闭 extended thinking           |
| `MAX_STEP`              | `10`                                 | agent 循环上限                           |
| `RUNTIME`               | `local`                              | `local` \| `docker` \| `opensandbox`     |
| `DOCKER_IMAGE`          | `tinyhands-sandbox:latest`           | 当 `RUNTIME=docker` 时                    |
| `OPENSANDBOX_SERVER_URL`| `http://localhost:8080`              | 当 `RUNTIME=opensandbox` 时              |
| `OPENSANDBOX_IMAGE`     | `opensandbox/code-interpreter:v1.1.0`| code-interpreter 镜像(内置 Jupyter)    |

## 内置工具

始终可用:`read_file`、`write_file`、`finish`。可选(创建会话时经 `tools`
字段开启):`run_bash`、`run_code`、`browser`。其中 `run_code`(带富输出的
Jupyter kernel)与 `browser`(Playwright)需要能提供它们的 runtime——
Docker 或 OpenSandbox。

## 开发

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

纯 ESM + TypeScript,用 `tsx` 直接运行。
