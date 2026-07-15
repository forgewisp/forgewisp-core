---
sidebar_position: 1
---

# @forgewisp/mcp

An opt-in adapter that connects to an MCP server over the **Streamable HTTP** transport and adapts
its tools into `FunctionDefinition`s — registered through the agent's existing `registerFunction`
path. So core's registry, Ajv validation, two-phase executor, `onConfirmRequired` invariant, audit
log, and `runToolLoop` all apply to MCP tools unchanged.

```bash npm2yarn
npm install @forgewisp/core @forgewisp/mcp
```

`@forgewisp/mcp` adds `@modelcontextprotocol/sdk` — isolated in this package so users who don't need
MCP never pull the SDK into their bundle.

## Two ways to use it

### `registerMcpServer(agent, config)` — the high-level form

Adapts a server's tools and registers them directly on your agent:

```ts
import { createAgent } from '@forgewisp/core';
import { registerMcpServer } from '@forgewisp/mcp';

const agent = createAgent({ /* ... */ onConfirmRequired: async () => true });

const handle = await registerMcpServer(agent, {
  name: 'my-mcp',
  url: 'https://example.com/mcp',
  apiKey: '...', // optional; mutually exclusive with authProvider
  defaultTier: 'read', // risk tiers come from config, NOT MCP hints
  tierOverrides: { sendEmail: 'write', dropTable: 'destructive' },
  hasConfirmation: true, // required if any tool maps to write/destructive
});
```

### `createMcpTools(config, options?)` — the lower-level, agent-free form

Returns the adapted `FunctionDefinition[]` (with `name`/`description`/`riskTier`) plus `close()` and
`finishAuth(code)`. Use it when you want to inspect or render the tools before registering them (the
`apps/mcp-demo` does this).

```ts
import { createMcpTools } from '@forgewisp/mcp';

const result = await createMcpTools({
  name: 'my-mcp',
  url: 'https://example.com/mcp',
  defaultTier: 'read',
  hasConfirmation: true,
});

for (const tool of result.tools) agent.registerFunction(tool);
// later:
await result.close();
```

## Key invariants

- **Risk tiers come from config, not MCP hints.** MCP has no tier concept. `defaultTier` (default
  `read`) + `tierOverrides` map per original tool name. MCP `annotations.readOnlyHint`/
  `destructiveHint` are informational only and deliberately **not** auto-mapped — you own the
  security boundary.
- **Confirmation preflight.** `registerMcpServer` resolves all tool tiers *before* registering
  anything; if any maps to `write`/`destructive` and `hasConfirmation` is not `true`, it closes the
  client and throws a clear error (no partial registration). Core's own registration-time invariant
  still fires as a backstop.
- **Schema pass-through.** MCP `inputSchema` is full draft-07; core's `JSONSchema` type is a narrow
  subset that is **not** widened. The adapter casts at the boundary — runtime is correct because
  core's Ajv is `strict: false` and the wire payload to the LLM carries the full schema.
- **Name namespacing.** Registered names are `${prefix}__<sanitized>`, sanitized to OpenAI's
  `^[A-Za-z0-9_-]{1,64}$`, with numeric suffixes on collision.
- **Result flattening.** `callTool` results reduce to one JSON-serializable value
  (`structuredContent` → single text → joined text → `{ content }`); `isError` throws so the
  executor records `function_errored`.
- **Abort.** The parent run's `AbortSignal` (via `ToolContext`) is forwarded to `client.callTool`,
  merged with a per-server `requestTimeoutMs`.

## OAuth

For OAuth 2.1 + PKCE flows (the `pending` → `finishAuth(code)` state machine, fresh-transport
resume, browser-redirect plumbing), see [OAuth](/docs/mcp/oauth).

## Builds

ESM + CJS only (no IIFE/global build) — inlining the MCP SDK into a self-contained global would be
heavy and fragile, since it relies on browser-native `fetch`/`EventSource`. Consumers bundle it
through their app bundler, which resolves the externalized SDK and peer core.

The generated API reference is at the bottom of this sidebar section.