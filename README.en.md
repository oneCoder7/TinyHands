# Tinyhands

**A complete agent runtime.**

[简体中文](README.md) | English

Tinyhands is a multi-conversation agent runtime. Run the current repository as a
service, create conversations and send messages over HTTP, and the agent will
autonomously reads/writes files, runs commands, executes code, and drives a
browser inside an isolatable execution environment until the task is done —
streaming every step back as an event stream.

The repository is split into `@tinyhands/protocol`, `@tinyhands/server`,
`@tinyhands/sdk`, and standalone npm workspaces with independent package exports.
They have not been published to the public npm registry yet. For now, consume
them from this workspace or from `npm pack` artifacts, and never deep-import a
package's internal `src/` modules.

It isn't an end-user product; it's the foundation for building agent apps
(coding assistant, data analysis, automation…) — sparing the cost of assembling
the whole stack from scratch: LLM loop + tool calling + execution sandbox +
session management + live streaming.

## What it does

- **Concurrent conversations** — one process hosts any number of isolated conversations, each with its own workspace and execution environment.
- **Autonomous tool loop** — a built-in ReAct loop: the agent picks a tool, sees the result, decides the next step, and repeats until it calls `finish`.
- **Pluggable execution** — the same code runs on the host, in Docker, or in an OpenSandbox cloud sandbox, switched by a single environment variable.
- **Live event stream** — every step (thinking, message, tool call, result) is pushed to subscribers, with replay-on-reconnect.
- **Resumable sessions** — the event stream is persisted to disk; after a restart, a conversation is recovered by its id and history continues without losing context.
- **Persistent execution tracing** — every HTTP trigger, Agent run, LLM call, and Tool execution is linked by stable IDs for post-restart inspection.
- **Cooperative interrupt** — a run can be interrupted at any time; the agent stops cleanly at a checkpoint, leaving no half state.
- **Automatic context compaction** — enabled by default with a 20k context window; creates recoverable checkpoints without deleting original events.
- **Streaming output** — token-level streaming, including live extended-thinking traces.

## Quick start

```bash
npm install

# configure provider/model and API key; compatible gateways also need URL and protocol
cp .env.example .env
$EDITOR .env

npm run serve        # listens on :8787 by default
```

The server starts with zero conversations — they are created on demand. A full
round-trip:

```bash
# 1) create a conversation, enabling the shell and code-execution tools
curl -XPOST localhost:8787/v1/conversations \
  -H 'content-type: application/json' \
  -d '{"conversationId":"demo","tools":["run_bash","run_code"]}'

# 2) subscribe to its event stream (in another terminal, keep it open)
curl -N localhost:8787/v1/conversations/demo/events

# 3) send a message and watch step 2 stream the agent's thinking, tool calls, and results
curl -XPOST localhost:8787/v1/conversations/demo/messages \
  -H 'content-type: application/json' \
  -d '{"text":"count the files in the current dir and write it to count.txt"}'
```

## Integration model

The typical pattern: **send commands over REST, watch results by subscribing to
the event stream.**

Remote Node.js callers can use `@tinyhands/sdk`. It depends only on the public
protocol, never on the server implementation. The package is not on the public
registry yet; this example applies to workspace or tarball consumers:

```ts
import { TinyhandsClient } from "@tinyhands/sdk";

const client = new TinyhandsClient({
  baseUrl: "http://localhost:8787",
  headers: () => ({ authorization: `Bearer ${getAccessToken()}` }),
});

const conversation = await client.conversations.create({ tools: ["run_bash"] });
for await (const item of conversation.events()) {
  // persisted events reconnect with Last-Event-ID; deltas do not move the anchor
  console.log(item);
}
```

A Node.js backend can also embed `@tinyhands/server` directly without Fastify
and without cloning or modifying Tinyhands source:

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

// Call the application port directly.
const conversation = await host.conversations.create({ tools: ["run_bash"] });
await host.conversations.send(conversation.conversationId, "analyze this directory");

// Or pass a WHATWG Request from any framework to the versioned /v1 handler.
const handleTinyhands = createTinyhandsFetchHandler({ host });
const response = await handleTinyhands(request);

await host.close();
```

`@tinyhands/server` exposes only its root entry and `@tinyhands/server/http`.
Environment parsing, the Pino instance, port binding, and process signals belong
to standalone. An embedding application keeps its own configuration, logging,
authorization, and server framework. Runtime configuration is a discriminated
union, so only the selected runtime's fields are required. Pass an application
logger through `logger` (Pino is structurally compatible), or omit it for a
silent Server library.

### 1. Create a conversation

`POST /v1/conversations`, optionally with `conversationId` (auto-generated
if omitted) and `tools` (the optional tools to enable). Each conversation gets
its own workspace and execution environment.

### 2. Subscribe to the event stream

Use SSE at `GET /v1/conversations/:id/events`. It is a read-only observation
window. Whether the agent runs is **completely
independent** of whether anyone is watching: it keeps running in the background
with no subscribers, and a new subscriber first receives the event history,
then switches to live. WebSocket is currently available only through the legacy API.

Send `Last-Event-ID: N` to replay only persisted events after sequence `N` on
reconnect; `?afterSeq=N` is also accepted. Transient deltas have no event id and
never advance the reconnect anchor.

Subscribers receive these events (each carries a monotonic `seq`):

| Event type          | Meaning                                            |
| ------------------- | -------------------------------------------------- |
| `user_message`      | a user message (echoed to all viewers)             |
| `thinking_finished` | a finalized thinking block (extended thinking)     |
| `agent_message`     | the agent's message + the tool calls it issued     |
| `tool_result`       | the result of one tool call                        |
| `finished`          | task complete (the agent called `finish`)          |
| `interrupted`       | the run was interrupted                            |
| `error`             | the run errored                                    |
| `compaction_started` | context compaction started and can be interrupted |
| `compaction_completed` | the compaction checkpoint was committed         |
| `compaction_cancelled` | compaction was cancelled by an interrupt or restart |
| `compaction_failed` | compaction failed with a stable error code         |

Plus the transient `delta` (streaming tokens / thinking chunks) — broadcast
only, never stored in history.
The internal `compacted` checkpoint is persisted but never exposed over WS/SSE.

### 3. Send / interrupt

`POST /v1/conversations/:id/messages` sends a message and triggers a run;
`POST /v1/conversations/:id/interrupt` cooperatively interrupts an in-progress run.
Both return an immediate acknowledgement — actual progress comes from the event
stream.

A successful `send` returns a persistent `triggerId`:

```json
{
  "accepted": true,
  "running": true,
  "triggerId": "550e8400-e29b-41d4-a716-446655440000"
}
```

One Agent step may consume multiple concurrently submitted triggers. Their
actual association with runs, LLM calls, and Tool executions is recorded in the
conversation's `run_log.jsonl`.

Full endpoints under [HTTP API](#http-api).

### 4. Persistent data

Conversation data is stored under `~/workspace/<conversationId>/` by default.
Development and test environments can use `TINYHANDS_HOME` to override `~`:

```text
~/workspace/<conversationId>/
├── meta.json
├── events.jsonl
└── run_log.jsonl
```

- `events.jsonl` is the conversation source of truth. It stores user messages,
  Agent/Tool results, and compaction checkpoints.
- `run_log.jsonl` stores run, step, LLM, and Tool lifecycles, durations, and
  provider-reported token usage. It does not duplicate prompts, responses, Tool
  arguments, or Tool result bodies.
- Deleting a conversation deletes its entire directory.

Tinyhands does not expose `/stats`, `/metrics`, or a Run Log query API. Inspect
the persisted JSONL when needed; a read model should be designed later from
actual query requirements.

## Design highlights

These are what make it easy to extend and embed:

- **The event stream is the single source of truth, and it's persisted.** Conversation state *is* an
  append-only event log; the context fed to the LLM is a pure projection of it. Once the stream is
  persisted to disk, a conversation is recovered by its id after a restart and history continues.
  That makes a conversation inherently auditable, replayable — time-travel-debugging it means
  consuming just this one stream.
- **Runtime ≠ Sandbox; execution location is pluggable.** Tools only express
  intent ("run this command"); a `Runtime` decides where it runs. Host, Docker,
  and cloud sandbox share one set of tool code, switched with zero changes.
- **Provider-neutral.** The whole core speaks one set of neutral LLM types; only
  provider adapters touch vendor SDK types. Swapping model or provider never
  leaks into business code.
- **Transport decoupled from execution.** WS/SSE are just observation windows;
  adding or dropping subscribers doesn't affect the agent, and adding a new
  downlink channel is cheap.

## Source extensions (forks and contributors only)

Tinyhands does not yet expose a public registration API for custom Tools,
Runtimes, or LLM providers. Consumers of a release must not modify Tinyhands
internals. The entries below are only for forks or contributions of built-in
implementations; they are not stable public extension contracts. A public Tool
extension mechanism will be designed separately once its isolation, permission,
and lifecycle requirements are concrete.

**Add a tool.** Implement the `Tool` interface (`name` / `description` / a Zod
`schema` / `execute`) and register one line in the catalog at
`packages/server/src/tools/catalog.ts`. Tools run through `ctx.runtime`, so they work across all
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
`packages/server/src/llm/factory.ts`. The agent and assembly layers don't change —
they depend only on the interface.

## Roadmap

- Publish the protocol, server, and SDK npm packages
- Design an external Tool extension contract that requires no Tinyhands source changes
- More built-in tools (web search, patch-based file editing, sub-task spawning)
- Full handling of `redacted_thinking` blocks (currently a known gap)
- More provider implementations
- Finer-grained resource quotas (per-conversation exec timeout, budget caps)

## HTTP API

New integrations use the versioned `/v1` REST + SSE API:

| Method | Path                                           | Purpose                       |
| ------ | ---------------------------------------------- | ----------------------------- |
| POST   | `/v1/conversations`                            | create a conversation         |
| GET    | `/v1/conversations`                            | list conversations            |
| DELETE | `/v1/conversations/:conversationId`            | delete a conversation         |
| POST   | `/v1/conversations/:conversationId/messages`   | submit a user message         |
| POST   | `/v1/conversations/:conversationId/interrupt`  | cooperatively interrupt a run |
| GET    | `/v1/conversations/:conversationId/events`     | SSE downlink event stream     |

`/v1` errors use `{ "error": { "code", "message" } }`. SSE supports
`Last-Event-ID` replay. An upper-layer adapter may authorize a request before it
enters the Host.

The old `/conversations/*`, `/sse/:id`, and `/ws/:id` endpoints remain in the
standalone app for compatibility only and receive no new features. `GET /health`
remains the standalone liveness probe.

## Configuration

The variables below are read once by the standalone launcher (see
`.env.example`). Direct `@tinyhands/server` consumers pass explicit
`TinyhandsHostOptions` to `createTinyhandsHost()`; the Server library itself does
not read environment variables.

Everything is read once from the environment at startup (see `.env.example`).

| Variable                | Default                              | Notes                                    |
| ----------------------- | ------------------------------------ | ---------------------------------------- |
| `LLM_MODEL`             | —                                    | required, `provider/model`, e.g. `openai/gpt-5` |
| `LLM_API_KEY`           | —                                    | unified API key; a provider-specific alias may be used instead |
| `LLM_BASE_URL`          | official provider endpoint           | private or compatible gateway URL        |
| `LLM_OPENAI_API_MODE`   | `responses`                          | `openai/*` only: `responses` \| `chat_completions` |
| `PORT`                  | `8787`                               |                                          |
| `TINYHANDS_HOME`        | `~`                                  | override home dir; workspace → `$TINYHANDS_HOME/workspace`. dev/test only |
| `LLM_MAX_TOKENS`        | `8192`                               |                                          |
| `LLM_THINKING_BUDGET`   | `2048`                               | `anthropic/*` only; `0` disables extended thinking |
| `LLM_AUTO_COMPACT_ENABLED` | `true`                             | enable automatic context compaction      |
| `LLM_CONTEXT_WINDOW`    | `20000`                              | total model context window; override per deployment |
| `LLM_AUTO_COMPACT_TRIGGER_RATIO` | `0.80`                    | trigger ratio over usable input budget   |
| `LLM_AUTO_COMPACT_TARGET_RATIO` | `0.50`                     | post-compaction target; must be below trigger ratio |
| `MAX_STEP`              | `10`                                 | agent loop cap                           |
| `RUNTIME`               | `local`                              | `local` \| `docker` \| `opensandbox`     |
| `DOCKER_IMAGE`          | `tinyhands-sandbox:latest`           | when `RUNTIME=docker`                    |
| `OPENSANDBOX_SERVER_URL`| `http://localhost:8080`              | when `RUNTIME=opensandbox`               |
| `OPENSANDBOX_IMAGE`     | `opensandbox/code-interpreter:v1.1.0`| code-interpreter image (built-in Jupyter)|

The supported provider prefixes are `anthropic/*` and `openai/*`. `LLM_MODEL`
is split only at the first `/`, so the model name itself may contain `/`.

```env
# Official Anthropic endpoint
LLM_MODEL=anthropic/your-model
LLM_API_KEY=your-token

# OpenAI Responses (the default protocol for openai/*)
LLM_MODEL=openai/your-model
LLM_API_KEY=your-token

# OpenAI-compatible Chat Completions gateway
LLM_MODEL=openai/your-model
LLM_API_KEY=your-token
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_OPENAI_API_MODE=chat_completions
```

Responses and Chat Completions never fall back to each other automatically.
Compatible gateways must explicitly select the protocol they actually support.

To migrate an old configuration, replace `LLM_PROVIDER=openai` plus
`LLM_MODEL=gpt-x` with `LLM_MODEL=openai/gpt-x`; `LLM_PROVIDER` has been removed.

## Built-in tools

Always available: `read_file`, `write_file`, `finish`. Optional (enable via the
`tools` field on create): `run_bash`, `run_code`, `browser`. `run_code` (a
Jupyter kernel with rich output) and `browser` (Playwright) need a runtime that
provides them — Docker or OpenSandbox.

## Development

```text
packages/
├── protocol/       # versioned DTOs, public events, stable errors; no server dependency
├── server/         # TinyhandsHost, Fetch handler, and Agent/Runtime core
└── sdk/            # remote TinyhandsClient; depends only on protocol
apps/
└── standalone/     # Fastify, legacy routes, env, listen, and signals
```

```bash
npm run typecheck    # build packages; check source, tests, and smoke scripts
npm test             # vitest run
```

The commands below use the real provider configured in `.env`, consume real
tokens, and are not part of regular CI:

```bash
npm run verify:provider  # streaming, parallel tools, result replay, client rebuild, interrupt
npm run verify:compact   # interrupt, next-query retry, checkpoint, and disk recovery
npm run verify:crash     # service start, SIGKILL, restart, SSE replay, and continuation
```

Real verification is protocol-specific. The smoke suite has passed against an
OpenAI-compatible Chat Completions endpoint. The Responses adapter has
protocol-level automated coverage, but still requires a real Responses endpoint
before its real integration can be claimed as verified.

Pure ESM + TypeScript, run directly with `tsx`.
