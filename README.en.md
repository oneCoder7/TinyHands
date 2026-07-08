# tinyhands

**A complete agent runtime.**

[简体中文](README.md) | English

tinyhands is an embeddable, multi-conversation agent runtime. You run it as a
service, create conversations and send messages over HTTP, and the agent
autonomously reads/writes files, runs commands, executes code, and drives a
browser inside an isolatable execution environment until the task is done —
streaming every step back to you as an event stream.

It isn't an end-user product; it's the foundation **downstream developers**
build on. You write your own agent app (coding assistant, data analysis,
automation…) on top of it, without having to build the whole stack yourself:
LLM loop + tool calling + execution sandbox + session management + live
streaming.

## What it does

- **Concurrent conversations** — one process hosts any number of isolated conversations, each with its own workspace and execution environment.
- **Autonomous tool loop** — a built-in ReAct loop: the agent picks a tool, sees the result, decides the next step, and repeats until it calls `finish`.
- **Pluggable execution** — the same code runs on the host, in Docker, or in an OpenSandbox cloud sandbox, switched by a single environment variable.
- **Live event stream** — every step (thinking, message, tool call, result) is pushed to subscribers, with replay-on-reconnect.
- **Cooperative interrupt** — a run can be interrupted at any time; the agent stops cleanly at a checkpoint, leaving no half state.
- **Streaming output** — token-level streaming, including live extended-thinking traces.

## Quick start

```bash
npm install

# configure: copy the template and fill in your gateway URL, model, and token
cp .env.example .env
$EDITOR .env

npm run serve        # listens on :8787 by default
```

The server starts with zero conversations — you create them on demand. A full
round-trip:

```bash
# 1) create a conversation, enabling the shell and code-execution tools
curl -XPOST localhost:8787/conversations/create \
  -d '{"conversationId":"demo","tools":["run_bash","run_code"]}'

# 2) subscribe to its event stream (in another terminal, keep it open)
curl -N localhost:8787/sse/demo

# 3) send a message and watch step 2 stream the agent's thinking, tool calls, and results
curl -XPOST localhost:8787/conversations/send \
  -d '{"conversationId":"demo","text":"count the files in the current dir and write it to count.txt"}'
```

## Integration model

The typical pattern: **send commands over REST, watch results by subscribing to
the event stream.**

### 1. Create a conversation

`POST /conversations/create`, optionally with `conversationId` (auto-generated
if omitted) and `tools` (the optional tools to enable). Each conversation gets
its own workspace and execution environment.

### 2. Subscribe to the event stream

Over WebSocket (`/ws/:id`) or SSE (`/sse/:id`) — the two are equivalent
read-only observation windows. Whether the agent runs is **completely
independent** of whether anyone is watching: it keeps running in the background
with no subscribers, and a new subscriber first receives the event history,
then switches to live.

Pass `?lastSeq=N` to replay only events after sequence `N` on reconnect — no
gaps, no duplicates.

You receive these events (each carries a monotonic `seq`):

| Event type          | Meaning                                         |
| ------------------- | ----------------------------------------------- |
| `user_message`      | a user message (yours is echoed to all viewers) |
| `thinking_finished` | a finalized thinking block (extended thinking)  |
| `agent_message`     | the agent's message + the tool calls it issued  |
| `tool_result`       | the result of one tool call                     |
| `finished`          | task complete (the agent called `finish`)       |
| `interrupted`       | the run was interrupted by the user             |
| `error`             | the run errored                                 |

Plus the transient `delta` (streaming tokens / thinking chunks) — broadcast
only, never stored in history.

### 3. Send / interrupt

`POST /conversations/send` sends a message and triggers a run;
`POST /conversations/interrupt` cooperatively interrupts an in-progress run.
Both return an immediate acknowledgement — actual progress comes from the event
stream.

Full endpoints under [HTTP API](#http-api).

## Design highlights

These are what make it easy to extend and embed:

- **The event stream is the single source of truth.** Conversation state *is* an
  append-only event log; the context fed to the LLM is a pure projection of it.
  That makes a conversation inherently auditable, replayable, and persistable —
  to store or time-travel-debug it, you consume just this one stream.
- **Runtime ≠ Sandbox; execution location is pluggable.** Tools only express
  intent ("run this command"); a `Runtime` decides where it runs. Host, Docker,
  and cloud sandbox share one set of tool code, switched with zero changes.
- **Provider-neutral.** The whole core speaks one set of neutral LLM types; only
  a single file actually imports the Anthropic SDK. Swapping model or provider
  never leaks into business code.
- **Transport decoupled from execution.** WS/SSE are just observation windows;
  adding or dropping subscribers doesn't affect the agent, and adding a new
  downlink channel is cheap.

## Extending

The three most common extension points, all open/closed — add new things
without touching old code:

**Add a tool.** Implement the `Tool` interface (`name` / `description` / a Zod
`schema` / `execute`) and register one line in the catalog at
`src/tools/catalog.ts`. Tools run through `ctx.runtime`, so they work across all
execution environments for free.

```ts
export const myTool: Tool<MyArgs> = {
  name: "my_tool",
  description: "shown to the LLM; influences when it picks this tool",
  schema: MyArgs,                       // zod/v4
  async execute(args, ctx) {
    const r = await ctx.runtime.exec(`...`);
    return { content: r.stdout, isError: r.exitCode !== 0 };
  },
};
```

**Swap the execution environment.** Implement the `Runtime` interface (`exec` /
`readFile` / `writeFile` / `runCode` / `runBrowser` + `create`/`kill`
lifecycle) to plug in any sandbox backend. The built-in `Local` / `Docker` /
`OpenSandbox` implementations are direct references.

**Add an LLM provider.** Implement the `LLMClient` interface (essentially one
`chat` method, speaking only neutral types) and add a `case` in
`src/llm/factory.ts`. The agent and assembly layers don't change — they depend
only on the interface.

## Roadmap

- More built-in tools (web search, patch-based file editing, sub-task spawning)
- Conversation persistence: store the event stream, resume after a restart
- Full handling of `redacted_thinking` blocks (currently a known gap)
- More provider implementations (native OpenAI protocol, etc.)
- Finer-grained resource quotas (per-conversation exec timeout, budget caps)

## HTTP API

All command endpoints are `POST` with a JSON body.

| Method | Path                        | Purpose                          |
| ------ | --------------------------- | -------------------------------- |
| GET    | `/health`                   | liveness / conversation count    |
| POST   | `/conversations/create`     | create a conversation            |
| POST   | `/conversations/list`       | list conversations               |
| POST   | `/conversations/delete`     | destroy a conversation           |
| POST   | `/conversations/send`       | submit a user message            |
| POST   | `/conversations/interrupt`  | cooperatively interrupt a run    |
| WS     | `/ws/:conversationId`       | downlink event stream            |
| SSE    | `/sse/:conversationId`      | downlink event stream            |

## Configuration

Everything is read once from the environment at startup (see `.env.example`).

| Variable                | Default                              | Notes                                    |
| ----------------------- | ------------------------------------ | ---------------------------------------- |
| `ANTHROPIC_AUTH_TOKEN`  | —                                    | required (or `LLM_API_KEY`)              |
| `LLM_BASE_URL`          | —                                    | required — Anthropic-style gateway URL   |
| `LLM_MODEL`             | —                                    | required — model name                    |
| `PORT`                  | `8787`                               |                                          |
| `WORKSPACE_ROOT`        | `./workspaces`                       | per-conversation subdir under it         |
| `LLM_MAX_TOKENS`        | `8192`                               |                                          |
| `LLM_THINKING_BUDGET`   | `2048`                               | `0` disables extended thinking           |
| `MAX_STEP`              | `10`                                 | agent loop cap                           |
| `RUNTIME`               | `local`                              | `local` \| `docker` \| `opensandbox`     |
| `DOCKER_IMAGE`          | `tinyhands-sandbox:latest`           | when `RUNTIME=docker`                    |
| `OPENSANDBOX_SERVER_URL`| `http://localhost:8080`              | when `RUNTIME=opensandbox`               |
| `OPENSANDBOX_IMAGE`     | `opensandbox/code-interpreter:v1.1.0`| code-interpreter image (built-in Jupyter)|

## Built-in tools

Always available: `read_file`, `write_file`, `finish`. Optional (enable via the
`tools` field on create): `run_bash`, `run_code`, `browser`. `run_code` (a
Jupyter kernel with rich output) and `browser` (Playwright) need a runtime that
provides them — Docker or OpenSandbox.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

Pure ESM + TypeScript, run directly with `tsx`.
