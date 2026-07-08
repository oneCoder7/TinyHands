# tinyhands

**A complete agent runtime.**

A multi-conversation agent service in TypeScript. One process hosts N independent
conversations — each with its own event stream, execution environment, and
workspace — driven externally over REST + WebSocket/SSE.

## Design

- **Event stream is the source of truth.** Every conversation is an append-only
  log of events; the `Message[]` fed to the LLM is a pure projection of that log,
  recomputed on demand.
- **Runtime ≠ Sandbox.** A `Runtime` decides *where* a tool runs. `LocalRuntime`
  runs on the host (no isolation); `DockerRuntime` and `OpenSandboxRuntime` add
  isolation. Tools only express intent (run a command, read/write a file) — the
  runtime decides execution location.
- **Neutral LLM types.** Only `anthropic-client.ts` imports the Anthropic SDK;
  everything else speaks a provider-neutral type vocabulary, so swapping the
  model provider touches one file.
- **Uplink is REST, downlink is WS/SSE.** Commands (send / interrupt) go through
  REST; WebSocket and SSE are read-only observation windows onto the event stream.
  Agent execution is fully decoupled from whether anyone is watching.

## Architecture

```
core/         config + logger
llm/          neutral types, LLMClient interface, Anthropic impl, factory
tools/        tool registry + catalog + individual tools
runtime/      Runtime interface + Local/Docker/OpenSandbox impls + execd
conversation/ event stream + conversation aggregate
agent/        the ReAct loop
server/       REST router, conversation manager, WS/SSE gateways, assembly
```

Dependency direction is strictly downward: `agent` depends on `conversation`,
`tools`, `llm`, `runtime` — none of them depend back on `agent`.

## Quick start

```bash
npm install

# configure: copy the template and fill in your gateway URL, model, and token
cp .env.example .env
$EDITOR .env

npm run serve        # tsx src/main.ts
```

The server listens on `:8787` by default and starts with zero conversations —
the upstream creates them on demand.

```bash
# create a conversation (optionally enabling extra tools)
curl -XPOST localhost:8787/conversations/create \
  -d '{"tools":["run_bash","run_code"]}'

# observe its event stream (SSE)
curl -N localhost:8787/sse/<conversationId>

# send a message
curl -XPOST localhost:8787/conversations/send \
  -d '{"conversationId":"<id>","text":"list files in the workspace"}'
```

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

Both downlink channels accept `?lastSeq=N` to replay events since sequence `N`
on reconnect.

## Configuration

Everything is read once from the environment at startup.

| Variable                | Default                              | Notes                                    |
| ----------------------- | ------------------------------------ | ---------------------------------------- |
| `ANTHROPIC_AUTH_TOKEN`  | —                                    | required (or `LLM_API_KEY`)              |
| `PORT`                  | `8787`                               |                                          |
| `WORKSPACE_ROOT`        | `./workspaces`                       | per-conversation subdir under it         |
| `LLM_BASE_URL`          | —                                    | required — Anthropic-style gateway URL   |
| `LLM_MODEL`             | —                                    | required — model name                    |
| `LLM_MAX_TOKENS`        | `8192`                               |                                          |
| `LLM_THINKING_BUDGET`   | `2048`                               | `0` disables extended thinking           |
| `MAX_STEP`              | `10`                                 | agent loop cap                           |
| `RUNTIME`               | `local`                              | `local` \| `docker` \| `opensandbox`     |
| `DOCKER_IMAGE`          | `tinyhands-sandbox:latest`           | when `RUNTIME=docker`                    |
| `OPENSANDBOX_SERVER_URL`| `http://localhost:8080`              | when `RUNTIME=opensandbox`               |
| `OPENSANDBOX_IMAGE`     | `opensandbox/code-interpreter:v1.1.0`| code-interpreter image (built-in Jupyter)|

## Tools

Always registered: `read_file`, `write_file`, `finish`. Optional (opt in via the
`tools` field on create): `run_bash`, `run_code`, `browser`. `run_code` (Jupyter
kernel with rich output) and `browser` (Playwright) require a runtime that
provides them — Docker or OpenSandbox.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # vitest run
```

Pure ESM + TypeScript, run directly with `tsx`.
