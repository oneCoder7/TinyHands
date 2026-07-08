# tinyhands

**一个完整的 agent runtime。**

简体中文 | [English](README.en.md)

用 TypeScript 写的多会话 agent 服务。单进程托管 N 个相互独立的会话——每个会话
拥有各自的事件流、执行环境和工作目录——由外部通过 REST + WebSocket/SSE 驱动。

## 设计

- **事件流是唯一真相源。** 每个会话是一条只追加的事件日志;喂给 LLM 的
  `Message[]` 是这条日志的纯投影,按需重新计算得出。
- **Runtime ≠ Sandbox。** `Runtime` 决定工具*在哪里*执行:`LocalRuntime`
  在宿主机上跑(零隔离),`DockerRuntime` 与 `OpenSandboxRuntime` 提供隔离。
  工具只表达意图(执行命令、读写文件),执行位置交给 runtime 决定。
- **中性 LLM 类型。** 只有 `anthropic-client.ts` 引入 Anthropic SDK,其余代码
  一律使用与厂商无关的中性类型,因此更换模型 provider 只需改动这一个文件。
- **上行走 REST,下行走 WS/SSE。** 命令(发消息 / 打断)统一经 REST;WebSocket
  与 SSE 是对事件流的只读观察窗口。agent 的执行与「有没有人在看」完全解耦。

## 架构

```
core/         配置 + 日志
llm/          中性类型、LLMClient 接口、Anthropic 实现、工厂
tools/        工具注册表 + 目录 + 各个工具
runtime/      Runtime 接口 + Local/Docker/OpenSandbox 实现 + execd
conversation/ 事件流 + 会话聚合根
agent/        ReAct 循环
server/       REST 路由、会话管理器、WS/SSE gateway、装配
```

依赖方向严格向下:`agent` 依赖 `conversation`、`tools`、`llm`、`runtime`——
它们都不反向依赖 `agent`。

## 快速开始

```bash
npm install

# 配置:复制模板,填入你的网关地址、模型名和 token
cp .env.example .env
$EDITOR .env

npm run serve        # tsx src/main.ts
```

服务默认监听 `:8787`,启动时零会话——由上游按需创建。

```bash
# 创建一个会话(可选启用额外工具)
curl -XPOST localhost:8787/conversations/create \
  -d '{"tools":["run_bash","run_code"]}'

# 观察它的事件流(SSE)
curl -N localhost:8787/sse/<conversationId>

# 发一条消息
curl -XPOST localhost:8787/conversations/send \
  -d '{"conversationId":"<id>","text":"列出工作目录里的文件"}'
```

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

两个下行通道都接受 `?lastSeq=N`,用于重连时补发序号 `N` 之后的历史事件。

## 配置

所有配置在启动时从环境变量读取一次。

| 变量                    | 默认值                               | 说明                                     |
| ----------------------- | ------------------------------------ | ---------------------------------------- |
| `ANTHROPIC_AUTH_TOKEN`  | —                                    | 必填(或用 `LLM_API_KEY`)               |
| `PORT`                  | `8787`                               |                                          |
| `WORKSPACE_ROOT`        | `./workspaces`                       | 每会话在其下有专属子目录                 |
| `LLM_BASE_URL`          | —                                    | 必填 —— Anthropic 风格网关地址           |
| `LLM_MODEL`             | —                                    | 必填 —— 模型名                           |
| `LLM_MAX_TOKENS`        | `8192`                               |                                          |
| `LLM_THINKING_BUDGET`   | `2048`                               | `0` 表示关闭 extended thinking           |
| `MAX_STEP`              | `10`                                 | agent 循环上限                           |
| `RUNTIME`               | `local`                              | `local` \| `docker` \| `opensandbox`     |
| `DOCKER_IMAGE`          | `tinyhands-sandbox:latest`           | 当 `RUNTIME=docker` 时                    |
| `OPENSANDBOX_SERVER_URL`| `http://localhost:8080`              | 当 `RUNTIME=opensandbox` 时              |
| `OPENSANDBOX_IMAGE`     | `opensandbox/code-interpreter:v1.1.0`| code-interpreter 镜像(内置 Jupyter)    |

## 工具

始终注册:`read_file`、`write_file`、`finish`。可选(创建会话时经 `tools` 字段
开启):`run_bash`、`run_code`、`browser`。`run_code`(带富输出的 Jupyter kernel)
与 `browser`(Playwright)需要能提供它们的 runtime —— Docker 或 OpenSandbox。

## 开发

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

纯 ESM + TypeScript,用 `tsx` 直接运行。
