# Forgewisp

[![GitHub stars](https://img.shields.io/github/stars/forgewisp/forgewisp-core?style=social)](https://github.com/forgewisp/forgewisp-core)
[![GitHub repo](https://img.shields.io/badge/repo-forgewisp%2Fforgewisp--core-blue)](https://github.com/forgewisp/forgewisp-core)

> ⭐ **Found Forgewisp useful? [Star the repo](https://github.com/forgewisp/forgewisp-core) on GitHub.**

> Safe, function-calling AI agents for the browser. Register your existing
> frontend functions as tools, get schema validation, a risk-tier execution
> model (read / write / destructive), streaming, and a reasoning stream —
> all with no mandatory backend.

## Packages

- **[`packages/core`](packages/core)** — `@forgewisp/core`, the library.
- **[`packages/bundled-tools`](packages/bundled-tools)** — `@forgewisp/bundled-tools`,
  a catalog of ready-to-register browser-effects tools (time, UUIDs, safe math,
  hashing, base64, viewport/battery/localStorage reads, clipboard/speech/download/
  geolocation/localStorage writes, a destructive localStorage remove, and an agent
  planning scratchpad persisted in `localStorage`).
- **[`apps/demo`](apps/demo)** — vanilla TypeScript + Vite demo: a
  task-manager UI driven by an AI agent whose tools mutate local state.
- **[`apps/bundled-demo`](apps/bundled-demo)** — vanilla TypeScript + Vite showcase
  that registers all of `@forgewisp/bundled-tools` and renders a toolkit sidebar
  plus an artifacts panel fed by the audit log.
- **[`apps/planning-demo`](apps/planning-demo)** — vanilla TypeScript + Vite demo of
  the agent planning tools (a job-tracking scratchpad persisted in `localStorage`).
- **[`apps/subagent-demo`](apps/subagent-demo)** — vanilla TypeScript + Vite
  orchestration demo: a pure-orchestrator parent agent that delegates read-only
  sub-tasks to fresh subagents via `spawnSubagent`, with a live "Subagent Runs"
  board fed by the audit log.

## Features

- **Register frontend functions as agent tools** with a JSON Schema for args.
- **Bundled tool catalog** — `@forgewisp/bundled-tools` ships ready-to-register
  browser-effects tools with strict JSON Schemas and safe handlers, so you can
  give an agent real browser capabilities in one `forEach`. See
  [`packages/bundled-tools`](packages/bundled-tools).
- **Risk tiers**: `read` runs immediately; `write` and `destructive` pause for
  developer-supplied confirmation. Confirmation UI is always rendered from
  validated args — never from LLM-generated text.
- **Streaming** for OpenAI-compatible endpoints (OpenAI, LiteLLM, OpenRouter,
  vLLM, …).
- **Reasoning stream** (four modes, set via `streaming.reasoning`):
  - `none` — no reasoning separation; `onReasoningChunk` is never called.
  - `extended` — OpenAI o1/o3 `reasoning_tokens` count (surfaced as an
    annotation).
  - `tag-based` — models that wrap reasoning in `<thinking>…</thinking>` (or
    any developer-specified tag). Forgewisp parses the stream in real time and
    routes inner content to `onReasoningChunk`, outer content to
    `onTextChunk`. Handles tags split across chunk boundaries.
  - `native` — the server streams reasoning in a separate delta field
    (`reasoning` for Ollama, `reasoning_content` for vLLM/DashScope); each
    reasoning delta is routed straight to `onReasoningChunk`. (The demo uses
    this mode.)
- **Audit log** of every function request, validation result, confirmation
  outcome, and execution result.
- **Subagent orchestration** — `createSubagentTool` builds a `spawnSubagent` tool
  that delegates a self-contained sub-task to a fresh child agent running its own
  tool loop. Only a trimmed result returns to the parent, so the child's
  intermediate reasoning and tool calls stay out of the parent's context. The
  child reuses the parent's connection, confirmation, and audit config — but not
  its system prompt or streaming UI callbacks. See
  [`packages/core`](packages/core).

## Quick start

```bash
pnpm install
pnpm build
pnpm test
```

Run a demo:

```bash
pnpm dev
# open http://localhost:5173
```

There are four apps — `apps/demo` (task manager), `apps/bundled-demo`
(bundled-tools showcase), `apps/planning-demo` (planning tools), and
`apps/subagent-demo` (subagent orchestration) — and all Vite dev servers default
to port 5173, so `pnpm dev` will start one there and bump the others to the next
free ports. To run just one, work in its directory:

```bash
cd apps/bundled-demo && pnpm dev      # the showcase
# or
cd apps/demo && pnpm dev              # the task manager
# or
cd apps/planning-demo && pnpm dev     # the planning demo
# or
cd apps/subagent-demo && pnpm dev     # the subagent orchestration demo
```

`apps/bundled-demo`, `apps/planning-demo`, and `apps/subagent-demo` all import
`@forgewisp/bundled-tools` via the workspace symlink to its `dist/`, so build
(or `dev`-watch) the package first:

```bash
pnpm --filter @forgewisp/bundled-tools build
```

Each demo will prompt for an LLM endpoint, model, and optional API key. It
persists these to `localStorage` under `forgewisp.demo.config` and reuses them on
reload; clear that key (or use the config overlay) to reconfigure.

## Usage

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
  handler: async ({ id }) => { tasks = tasks.filter((t) => t.id !== id); },
});

const result = await agent.run('Delete task 2 and list the rest.');
```

## Agent API

The public surface is intentionally small — `createAgent`, `createSubagentTool`,
and `defineToolSet`, plus the types they expose. Every config field is documented
in [`packages/core/src/types.ts`](packages/core/src/types.ts); the essentials:

- `agent.run(message, options?)` — `options` is
  `{ signal?: AbortSignal; history?: ChatMessage[] }`. `history` lets you warm
  the conversation with prior turns and accepts only user/assistant text
  (tool plumbing is not exposed, so callers can't build transcripts the API
  would reject).
- `agent.registerFunction(def)` / `agent.deregisterFunction(name)` /
  `agent.clearAuditLog()`. Registering a `write`/`destructive` tool **throws at
  registration time** if `onConfirmRequired` is not configured.
- `agent.registerToolSet(set)` — register a named `ToolSet` (built with
  `defineToolSet`) in one call.
- Tool handlers receive `(args, context?)` where `context` is a `ToolContext`
  (`{ signal?: AbortSignal }`) carrying the parent run's `AbortSignal`; long-running
  handlers can use it to abort. The second arg is optional, so existing one-arg
  handlers keep working.
- `createSubagentTool(config)` — build a `spawnSubagent` tool that delegates a
  sub-task to a fresh child agent and returns a trimmed result. See
  [`packages/core`](packages/core) for the full config/args/result shapes and the
  risk-tier rationale.
- `streaming.onMalformedChunk` — fires when an SSE `data:` line can't be parsed
  as JSON; the stream continues.
- `audit` config block: `maxEvents` (default 1000, oldest dropped when
  exceeded), `onEvent` (called after every event), and `redact` (applied to
  each event **before** storage and before `onEvent`).
- Defaults: `requestTimeoutMs` 60000 (set 0 to disable), `maxToolRounds` 10.

## Production: use a proxy

Forgewisp runs in the browser and talks directly to an OpenAI-compatible
endpoint. **Do not ship your provider API key in client-side code.** Any key
embedded in browser code is extractable and will be abused. In production,
route requests through a proxy you control that injects the key server-side,
and point `llmEndpoint` at that proxy. [LiteLLM](https://github.com/BerriAI/liteLLM)
is a good fit since it speaks the OpenAI-compatible API Forgewisp already uses.

Minimal `litellm_config.yaml` exposing a model under a virtual name and
protecting it with a master key:

```yaml
model_list:
  - model_name: gpt-4o            # the name your client sends
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY   # kept on the server, never shipped
      input_cost_per_token: 0.000005
      output_cost_per_token: 0.000015

litellm_settings:
  drop_params: true
  request_timeout: 120

general_settings:
  master_key: os.environ/LITELLM_MASTER_KEY   # required when proxy is on the web
```

Start the proxy (`pip install 'litellm[proxy]'`):

```bash
export OPENAI_API_KEY=sk-...
export LITELLM_MASTER_KEY=sk-...
litellm --config litellm_config.yaml --port 4000
```

Put it behind your own domain/TLS (e.g. `https://your-proxy.example.com`) and,
if it is internet-facing, lock it down with auth, rate limits, and CORS scoped
to your app's origin. Then point Forgewisp at the proxy instead of the provider:

```ts
const agent = createAgent({
  llmEndpoint: 'https://your-proxy.example.com/v1/chat/completions',
  // If your proxy requires the LiteLLM master key (or a virtual key you minted
  // for this client), pass it as apiKey. It is *not* your provider key — that
  // stays on the server — but treat it as a secret of its own and rotate it.
  apiKey: 'sk-litellm-virtual-key-for-this-client',
  model: 'gpt-4o', // matches model_name in litellm_config.yaml
  // ...
});
```

`apiKey` is fine for local development and the demo (where the key never leaves
your machine); in a deployed app prefer a short-lived virtual key over the
proxy's master key.

## Toolchain

- Node.js ≥ 18, pnpm ≥ 9.
- Turborepo for task orchestration.
- tsup for builds (ESM, CJS, IIFE) — `@forgewisp/core` ships
  `dist/index.{mjs,cjs,global.js}` + `.d.ts`. Its only runtime dependency is
  [`ajv`](https://ajv.js.org/).
- Vitest for tests.
- ESLint + Prettier for code quality.

## CI & releases

CI (`.github/workflows/ci.yml`) runs `format:check`, `lint`, `typecheck`,
`build`, and `test` on Node 20 with `pnpm install --frozen-lockfile`. Releases
are tag-driven (`v*`): the workflow verifies the tag matches the
`packages/core/package.json` version, then publishes `@forgewisp/core` to npm
with provenance and creates a GitHub release. Bump the package version
alongside a release tag.

## License

MIT