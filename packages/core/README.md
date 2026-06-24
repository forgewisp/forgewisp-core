# `@forgewisp/core`

[![GitHub stars](https://img.shields.io/github/stars/forgewisp/forgewisp-core?style=social)](https://github.com/forgewisp/forgewisp-core)
[![GitHub repo](https://img.shields.io/badge/repo-forgewisp%2Fforgewisp--core-blue)](https://github.com/forgewisp/forgewisp-core)

> ⭐ **Found Forgewisp useful? [Star the repo](https://github.com/forgewisp/forgewisp-core) on GitHub.**

> Safe, function-calling AI agents for the browser. Register your existing
> frontend functions as tools, get JSON Schema validation, a risk-tier
> execution model (`read` / `write` / `destructive`), OpenAI-compatible
> streaming, a reasoning stream, and an audit log — all with no mandatory
> backend.

Forgewisp runs entirely in the browser. It talks directly to any
OpenAI-compatible chat-completions endpoint (OpenAI, LiteLLM, OpenRouter,
vLLM, Ollama, …) and exposes a tiny, typed surface: `createAgent`,
`createSubagentTool`, and `defineToolSet`, plus the types they export. The only
runtime dependency is [`ajv`](https://ajv.js.org/) for argument validation.

## Install

```bash
pnpm add @forgewisp/core
# or
npm install @forgewisp/core
```

ESM, CommonJS, and a browser global (`dist/index.global.js`) builds are
shipped, with full TypeScript definitions. Node.js ≥ 18.

## Quick start

```ts
import { createAgent } from '@forgewisp/core';

const agent = createAgent({
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  systemPrompt: 'You manage tasks. Use the provided tools.',
  onConfirmRequired: async (call) => {
    return window.confirm(`${call.functionName}: ${JSON.stringify(call.args)}`);
  },
  audit: {
    onEvent: (event) => console.log('[audit]', event),
  },
  streaming: {
    reasoning: { mode: 'tag-based', tag: 'thinking' },
    onTextChunk: (chunk) => appendToUI(chunk),
    onReasoningChunk: (chunk) => appendReasoningToUI(chunk),
  },
});

agent.registerFunction({
  name: 'listTasks',
  description: 'List all tasks.',
  riskTier: 'read',
  parameters: { type: 'object', properties: {}, required: [] },
  handler: async () => tasks,
});

agent.registerFunction({
  name: 'deleteTask',
  description: 'Delete a task by id.',
  riskTier: 'destructive',
  parameters: {
    type: 'object',
    properties: { id: { type: 'integer', minimum: 1 } },
    required: ['id'],
  },
  handler: async ({ id }) => {
    tasks = tasks.filter((t) => t.id !== id);
  },
});

const result = await agent.run('Delete task 2 and list the rest.');
```

## API

The public surface is intentionally small — `createAgent`, `createSubagentTool`,
and `defineToolSet`, plus the types they re-export. The agent class itself is not
exported; name its type with `ReturnType<typeof createAgent>`. Every config
field is documented inline in [`src/types.ts`](src/types.ts); the essentials
follow.

### `createAgent(config: ForgewispConfig): ForgewispAgent`

Creates and returns an agent. `ForgewispConfig` fields:

| Field                | Type                                              | Notes                                                                              |
| -------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `llmEndpoint`        | `string`                                          | Any OpenAI-compatible `/chat/completions` URL.                                     |
| `apiKey`             | `string?`                                         | Sent as `Authorization: Bearer`. Omit for proxied/no-auth endpoints.              |
| `model`              | `string`                                          | Model identifier, e.g. `'gpt-4o'`.                                                 |
| `systemPrompt`       | `string?`                                         | Prepended to every conversation.                                                   |
| `onConfirmRequired`  | `(call: PendingCall) => Promise<boolean>?`        | Required when any tool has `riskTier !== 'read'` — registering one throws otherwise. |
| `audit`              | `AuditConfig?`                                    | `maxEvents` (default 1000), `onEvent`, `redact`.                                  |
| `streaming`          | `StreamingConfig?`                                | Reasoning mode + per-chunk callbacks. Omit to disable streaming.                  |
| `requestTimeoutMs`   | `number?`                                         | Default 60000; set `0` to disable.                                                 |
| `maxToolRounds`      | `number?`                                         | Default 10.                                                                        |

### `agent.run(message, options?): Promise<AgentResult>`

`options` is `{ signal?: AbortSignal; history?: ChatMessage[] }`. `history`
lets you warm the conversation with prior turns; only `user`/`assistant` text
turns are accepted — internal tool plumbing is not exposed, so callers can't
build transcripts the API would reject. The returned `AgentResult` carries
the final `response`, any captured `reasoning`, a `truncated` flag (true when
`maxToolRounds` is hit without a final response), and the lists of executed
and aborted tool calls.

### `agent.registerFunction(def)` / `agent.deregisterFunction(name)` / `agent.clearAuditLog()`

Register a tool with a `name`, `description`, JSON Schema `parameters`,
`riskTier`, and `handler`. Registering a `write`/`destructive` tool **throws
at registration time** if `onConfirmRequired` is not configured.

The `handler` is `(args, context?) => unknown`, where `context` is a `ToolContext`
(`{ signal?: AbortSignal }`). The signal is the parent run's `AbortSignal`
(`agent.run({ signal })`), threaded through the tool loop and executor so
long-running handlers can abort early. The second argument is optional, so
existing `(args) => …` handlers keep working unchanged.

### `agent.registerToolSet(set)` / `defineToolSet({ name, tools })`

`defineToolSet` bundles a named, reusable `ToolSet` of `FunctionDefinition`s;
`agent.registerToolSet(set)` registers every tool in it in one call. Useful for
shipping a coherent group of tools together — `@forgewisp/bundled-tools`
exports a ready-made `PLANNING_TOOLS` `ToolSet` this way.

## Risk tiers

A security boundary, not a UX nicety.

- **`read`** — runs immediately, no confirmation.
- **`write`** / **`destructive`** — `onConfirmRequired` is invoked with a
  `PendingCall` whose `args` are **always schema-validated, never raw LLM
  output**. Resolve `true` to proceed or `false` to abort. Confirmation UI
  must always be rendered from these validated args, never from LLM-generated
  text.

Tool calls are validated and executed concurrently. Each call's audit events
are buffered and flushed in input order, so the log preserves call order even
when later calls finish first.

## Subagents

`createSubagentTool(cfg)` builds a `spawnSubagent` tool that delegates a
self-contained sub-task to a fresh child agent running its own tool loop. The
child runs to completion and only a **trimmed** result returns to the parent's
tool message, so the child's intermediate reasoning and tool calls stay out of
the parent's context — useful for heavy, isolatable sub-tasks.

The child reuses the parent's connection (`llmEndpoint`, `apiKey`, `model`,
`requestTimeoutMs`), confirmation (`onConfirmRequired`), and audit
(`onAuditEvent`, `audit`) config, plus the parent's `streaming.reasoning` mode.
It deliberately does **not** inherit the parent's `systemPrompt` (a subagent is
a focused worker) or the parent's `streaming.onTextChunk`/`onReasoningChunk`
(would pollute the parent's UI).

`SubagentToolConfig` fields:

| Field           | Type                                  | Notes                                                                                          |
| --------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `config`        | `ForgewispConfig`                     | The parent's config — see reuse rules above.                                                   |
| `tools`         | `ToolSet \| readonly FunctionDefinition[]` | The tool pool the subagent may use; `spawnSubagent` itself is filtered out (recursion guard). |
| `systemPrompt?` | `string`                              | Default subagent system prompt; does not inherit the parent's.                                |
| `maxToolRounds?` | `number`                             | Default cap on the subagent's tool-call rounds.                                               |

`SpawnSubagentArgs` (the LLM-facing args):

- `task: string` (required) — self-contained task; the subagent sees no parent
  conversation.
- `tools?: string[]` — names of pool tools to grant (max 20). Omit for the
  whole pool. Must not include `spawnSubagent`. If the names match nothing, the
  factory falls back to the whole pool rather than registering zero tools.
- `systemPrompt?: string` — per-call override.
- `maxToolRounds?: number` — per-call override (1–40).

`SpawnSubagentResult` (returned to the parent's tool message):
`response`, `truncated`, `toolCallsExecuted`, `toolCallsAborted`. It
deliberately drops `reasoning` and the full executed/aborted call arrays — the
whole point is keeping the parent's context small.

The `spawnSubagent` tool is `read`-tier **by exception**: it is agent-owned
orchestration control flow, and gating it on `onConfirmRequired` would block the
loop. The subagent's own `write`/`destructive` tool calls are still gated by the
reused parent `onConfirmRequired`. The factory also injects the pool's exact
tool names into the tool `description`, so the parent LLM doesn't guess names
that don't match registered functions.

```ts
import { createAgent, createSubagentTool } from '@forgewisp/core';

agent.registerFunction(
  createSubagentTool({
    config: parentConfig,
    tools: SAFE_READ_TOOLS, // a ToolSet or readonly FunctionDefinition[]
    systemPrompt: 'You are a focused subagent. Return a concise final answer.',
    maxToolRounds: 15,
  }),
);
```

## Reasoning stream

Set via `streaming.reasoning`:

- **`none`** — no reasoning separation; `onReasoningChunk` is never called.
- **`extended`** — OpenAI o1/o3 `reasoning_tokens` count, surfaced as an
  annotation (the API returns no streamed reasoning text).
- **`tag-based`** — models that wrap reasoning in a developer-specified tag
  (e.g. `<thinking>…</thinking>`). Forgewisp parses the stream in real time,
  routing inner content to `onReasoningChunk` and outer content to
  `onTextChunk`. Handles tags split across chunk boundaries.
- **`native`** — the server streams reasoning in a separate delta field
  (`reasoning` for Ollama, `reasoning_content` for vLLM/DashScope); each delta
  is routed straight to `onReasoningChunk`.

`streaming.onMalformedChunk` fires when an SSE `data:` line can't be parsed as
JSON; the stream continues.

## Audit log

Every function request, validation result, confirmation outcome, execution
result, and stream anomaly is recorded as an `AuditEvent`. The log is a bounded
ring (`audit.maxEvents`, default 1000, oldest dropped). Optional `audit.redact`
runs **before** storage and before `onEvent` — use it to strip secrets from
`args`/`result`/`error`. A throwing `onEvent` is caught and recorded as
`audit_callback_errored`; audit callbacks never break the tool loop.

## Production: use a proxy

Forgewisp runs in the browser and talks directly to an OpenAI-compatible
endpoint. **Do not ship your provider API key in client-side code.** Any key
embedded in browser code is extractable and will be abused. In production,
route requests through a proxy you control that injects the key server-side,
and point `llmEndpoint` at that proxy.
[LiteLLM](https://github.com/BerriAI/liteLLM) is a good fit since it speaks the
OpenAI-compatible API Forgewisp already uses.

`apiKey` is fine for local development (where the key never leaves your
machine); in a deployed app prefer a short-lived virtual key over the proxy's
master key.

## License

MIT