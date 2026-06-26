# `@forgewisp/mcp`

[![GitHub stars](https://img.shields.io/github/stars/forgewisp/forgewisp-core?style=social)](https://github.com/forgewisp/forgewisp-core)
[![GitHub repo](https://img.shields.io/badge/repo-forgewisp%2Fforgewisp--core-blue)](https://github.com/forgewisp/forgewisp-core)

> ⭐ **Found Forgewisp useful? [Star the repo](https://github.com/forgewisp/forgewisp-core) on GitHub.**

> Model Context Protocol (MCP) client support for
> [Forgewisp](https://github.com/forgewisp/forgewisp-core) agents — connect an
> MCP server over Streamable HTTP and expose its tools as agent
> `FunctionDefinition`s, with JSON Schema validation, the risk-tier
> confirmation boundary, the audit log, and `runToolLoop` all applying
> unchanged.

MCP becomes just another source of `FunctionDefinition`s. This package
connects to an MCP server, lists its tools, and adapts each one into a
`FunctionDefinition` that is registered through the agent's existing
`registerFunction` path — so everything core already does for hand-authored
tools (registry, Ajv validation, two-phase executor, `onConfirmRequired`
invariant, audit log, abort propagation, the tool loop) applies to MCP tools
for free. **`@forgewisp/core` is not modified and is a types-only/peer
dependency here**; the only runtime dependency this package adds is
[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk).
Isolating the SDK in this opt-in package keeps users who don't need MCP from
pulling it into their bundle.

## Install

```bash
pnpm add @forgewisp/mcp @forgewisp/core
# or
npm install @forgewisp/mcp @forgewisp/core
```

`@forgewisp/core` is a peer dependency. ESM and CommonJS builds are shipped
(`dist/index.mjs`, `dist/index.cjs`, `dist/index.d.ts`) — there is **no
self-contained browser global build**, since inlining the MCP SDK (which
relies on browser-native `fetch`/`EventSource`) into a single IIFE bundle
would be heavy and fragile. Consumers bundle it through their app bundler,
which resolves the externalized SDK and peer core. Node.js ≥ 18.

## Quick start

```ts
import { createAgent } from '@forgewisp/core';
import { registerMcpServer } from '@forgewisp/mcp';

const agent = createAgent({
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  systemPrompt: 'You can use tools from the connected MCP server.',
  // write/destructive tools require this — see "Risk tiers & confirmation".
  onConfirmRequired: async (call) =>
    window.confirm(`${call.functionName}: ${JSON.stringify(call.args)}`),
});

// Connect, list tools, adapt, and register them on the agent in one call.
const handle = await registerMcpServer(
  agent,
  {
    name: 'my-server',
    url: 'https://example.com/mcp',
    apiKey: process.env.MCP_API_KEY, // optional; omitted entirely when unset
    defaultTier: 'read',
    tierOverrides: { sendEmail: 'write' }, // assign tiers per original tool name
    hasConfirmation: true, // required if any tool resolves to write/destructive
  },
);

console.log(handle.toolNames); // e.g. ['my-server__search', 'my-server__sendEmail']

const result = await agent.run('Search the docs for "MCP" and email me a summary.');

// Later: deregister all tools and disconnect.
await handle.close();
```

Use the lower-level `createMcpTools` when you want the adapted
`FunctionDefinition[]` in hand without touching any agent — for custom
registration, a `ToolSet`, or rendering a tier-grouped tool list:

```ts
import { createMcpTools } from '@forgewisp/mcp';

const { tools, authState, close, finishAuth } = await createMcpTools({
  name: 'my-server',
  url: 'https://example.com/mcp',
  defaultTier: 'read',
});

for (const def of tools) agent.registerFunction(def); // register however you like
// `tools[i].name`, `.description`, and `.riskTier` are populated for UI rendering.

await close(); // disconnect when done
```

## API

### `registerMcpServer(agent, config, options?): Promise<McpServerHandle>`

Connect to an MCP server, list its tools, adapt each into a
`FunctionDefinition`, and register them on `agent` (any object with
`registerFunction` / `deregisterFunction` — `ReturnType<typeof createAgent>`
satisfies this structurally). Returns a handle for lifecycle management.

- **Confirmation preflight.** Before registering anything, if any adapted
  tool resolves to `write`/`destructive` and `config.hasConfirmation` is not
  `true`, the client is closed and a clear error is thrown — so a tier
  mismatch never leaves a partially-registered server. Core's own
  registration-time invariant still fires as a backstop inside
  `agent.registerFunction`.
- **OAuth.** When the first connect needs auth, no tools are registered yet
  and the preflight is deferred until `handle.finishAuth(code)` lists the
  tools (see [OAuth 2.1 + PKCE](#oauth-21--pkce)).

### `createMcpTools(config, options?): Promise<McpToolsResult>`

The agent-free form: connect, list, and adapt without registering on any
agent. Returns `{ tools, authState, close, finishAuth }`. `tools` is empty
while `authState` is `'pending'` and is mutated in place once auth completes,
so the caller's reference stays valid. `close`/`finishAuth` are arrow
properties (they destructure cleanly).

### `McpServerConfig`

| Field               | Type                                  | Default     | Description                                                                                                                                                                                          |
| ------------------- | ------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`              | `string`                              | —           | Logical server name. Used as the default `toolNamePrefix` and the attribution suffix on each tool's description.                                                                                    |
| `url`               | `string`                              | —           | Streamable HTTP endpoint URL of the MCP server.                                                                                                                                                      |
| `apiKey`            | `string?`                             | —           | Bearer token sent as `Authorization`. Omitted entirely when unset (so no-auth/proxy endpoints work). Mutually exclusive with `authProvider`; if both are set, `authProvider` wins and `apiKey` is ignored. |
| `authProvider`       | `OAuthClientProvider?`                | —           | Drives the full OAuth 2.1 + PKCE flow via the SDK. Takes precedence over `apiKey`.                                                                                                                   |
| `requestTimeoutMs`  | `number?`                             | `60000`     | Per-call timeout for `listTools`/`callTool`, in ms.                                                                                                                                                  |
| `toolNamePrefix`    | `string?`                             | `config.name` | Prefix for the registered (prefixed) tool names.                                                                                                                                                     |
| `defaultTier`       | `RiskTier?`                           | `'read'`    | Risk tier for tools not listed in `tierOverrides`.                                                                                                                                                  |
| `tierOverrides`     | `Record<string, RiskTier>?`           | `{}`        | Map of original MCP tool name → risk tier (overrides `defaultTier`).                                                                                                                                |
| `onlyTools`         | `string[]?`                           | —           | Allowlist of original MCP tool names to register; all others are skipped. `[]` registers none.                                                                                                      |
| `excludeTools`      | `string[]?`                           | —           | Blocklist of original MCP tool names to skip.                                                                                                                                                       |
| `hasConfirmation`   | `boolean?`                            | —           | Required to be `true` when any resolved tool tier is `write`/`destructive`; `registerMcpServer` throws up front otherwise.                                                                          |

### `McpServerHandle`

| Field         | Type                                          | Description                                                                                       |
| ------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `toolNames`   | `string[]`                                    | The prefixed tool names registered on the agent. Empty while `authState` is `'pending'`.        |
| `authState`   | `'authorized' \| 'pending'`                   | `'pending'` means OAuth is required and `finishAuth` (or resume) is needed before tools exist.    |
| `finishAuth`  | `(code: string) => Promise<void>`             | Complete the OAuth redirect-back: exchange the code, reconnect, list tools, run preflight, register. |
| `close`       | `() => Promise<void>`                         | Deregister all of this server's tools and disconnect.                                            |

### Re-exported types

The package re-exports the core types you need (`FunctionDefinition`,
`RiskTier`, `JSONSchema`, `JSONSchemaProperty`, `ToolContext`) and the SDK
OAuth shapes (`OAuthClientProvider`, `OAuthTokens`, `OAuthClientMetadata`,
`OAuthClientInformationMixed`) so you can import everything from
`@forgewisp/mcp`.

## How adaptation works

- **Risk tiers come from config, not MCP hints.** MCP has no tier concept.
  `defaultTier` + `tierOverrides` assign tiers; MCP
  `annotations.readOnlyHint`/`destructiveHint` are informational only and
  deliberately **not** auto-mapped — the consumer owns the security boundary.
- **Schema pass-through.** MCP `inputSchema` is full draft-07 JSON Schema.
  Forgewisp's `JSONSchema` type is a narrow subset that is **not** widened; the
  adapter casts the raw `inputSchema` at the boundary. Runtime is correct:
  core's Ajv is `strict: false` and validates draft-07 (`$ref`/`enum`/`oneOf`
  …), the compiled validator is cached per schema-object identity, and the
  wire payload to the LLM carries the full schema. (External `$ref`s won't
  resolve — they don't appear in well-formed MCP schemas.)
- **Name namespacing.** Registered names are `${prefix}__<sanitized>`,
  sanitized to OpenAI's `^[A-Za-z0-9_-]{1,64}$`, with numeric suffixes on
  collision. Tools are called by their **original** (un-prefixed) name so the
  MCP server sees the right handler.
- **Result flattening.** MCP `callTool` results are reduced to a single
  JSON-serializable value: `structuredContent` preferred, then a single
  `text` item's `.text`, then joined text, else `{ content }`. `isError`
  throws so the executor records `function_errored`.
- **Abort.** The parent run's `AbortSignal` (threaded in via `ToolContext`) is
  forwarded to `client.callTool`, merged with the per-server
  `requestTimeoutMs` — aborting the parent run aborts in-flight MCP calls, and
  the timeout covers both the connect handshake and each `callTool`/`listTools`.

## Risk tiers & confirmation

`@forgewisp/mcp` respects the same risk-tier boundary as `@forgewisp/core`.
**Tier discipline is a security boundary here too:**

- **`read`** tools run immediately, no confirmation.
- **`write` / `destructive`** tools require the consumer to configure
  `onConfirmRequired` **and** pass `hasConfirmation: true` to
  `registerMcpServer`. The package runs a preflight before registering
  anything; core's own registration-time invariant fires as a backstop.

**Confirmation UI must be rendered only from the schema-validated
`PendingCall.args`** — never from raw LLM output. The executor validates args
against the JSON Schema before confirmation, so the args you get back are
guaranteed well-formed.

## OAuth 2.1 + PKCE

`config.authProvider` (an SDK `OAuthClientProvider`) takes precedence over
`apiKey` and drives the full OAuth 2.1 authorization-code + PKCE flow via the
SDK: RFC 9728/8414 discovery, dynamic client registration (RFC 7591), token
exchange, and refresh. The consumer implements the provider and owns
browser-redirect plumbing + token storage. `client/auth.js` (and its
`UnauthorizedError`) is dynamically imported **only on the OAuth path** —
non-OAuth consumers never load the auth module.

The consumer-visible state machine is `McpAuthState = 'authorized' | 'pending'`:

- A first connect that needs auth returns `authState: 'pending'` with an
  empty `tools` array instead of throwing — the SDK has already called
  `provider.redirectToAuthorization`. The consumer redirects the user to the
  authorization server, then calls `handle.finishAuth(code)` once the
  redirect-back arrives.
- **Fresh transport on resume.** `finishAuth(code)` is not "reconnect the
  spent transport." The SDK's `Client.connect` catches the `UnauthorizedError`
  thrown during the redirect, calls `void this.close()` (which aborts the
  transport's `AbortController` but does not null it), and rethrows — so a
  second `start()` on that transport throws `"already started"`. The same
  transport cannot be re-`connect`ed. So `finishAuth(code)` exchanges the code
  on the spent transport (its `finishAuth` only calls `auth()`, independent of
  `start()`), disconnects it, builds a **fresh** transport whose `connect`
  reads `provider.tokens()` and succeeds, then re-lists tools and splices them
  into the caller's `tools` array in place. The same fresh-transport pattern
  backs `McpConnectOptions.authorizationCode` (the page-reload resume path:
  exchange the code on a fresh transport *before* connecting).

```ts
const handle = await registerMcpServer(agent, {
  name: 'oauth-server',
  url: 'https://example.com/mcp',
  authProvider: myOAuthProvider, // your OAuthClientProvider implementation
  defaultTier: 'read',
  hasConfirmation: true,
});

if (handle.authState === 'pending') {
  // The SDK already redirected the user to authorize. When they come back
  // with `?code=...&state=...`, complete the flow:
  await handle.finishAuth(authorizationCode);
}

// After a page reload, resume in one shot instead of re-prompting:
const handle = await registerMcpServer(agent, config, { authorizationCode: code });
```

See `apps/mcp-demo` for a complete `OAuthClientProvider` backed by
`localStorage` (popup + same-tab fallback, `oauth-callback.html`, and a
load-resume path via `createMcpTools(config, { authorizationCode })`).

## Security in production

Connecting an agent to an MCP server exposes it to that server's tools, their
schemas, and the text those tools return. Treat everything coming from the
server as untrusted input, the same way you would treat model output. The
risk-tier and confirmation machinery above is necessary but not sufficient —
in production, also mind these points:

- **Treat MCP servers as a trust boundary.** The agent will call a
  server's tools based on model decisions, with whatever tiers you assigned.
  Only connect to servers you control or have vetted. Audit which tools a
  server exposes (`onlyTools` / `excludeTools`) before granting it
  `write`/`destructive` tiers — do not blanket-map an untrusted server's
  tools to `destructive`.
- **Tiers come from you, not the server.** MCP has no risk concept, and this
  adapter deliberately does **not** auto-map `annotations.readOnlyHint` /
  `destructiveHint`. The server controls its own annotations; trusting them
  would let a server self-promote a tool to `read` and skip confirmation.
  Decide tiers in `McpServerConfig` (`defaultTier` + `tierOverrides`) per
  tool you actually intend to expose.
- **Tool descriptions and results are prompt-injection vectors.** Each adapted
  tool's `description` is the server's own description text, and tool results
  flow back into the conversation as model input. A compromised or hostile
  server can craft descriptions/results that steer the model to call other
  tools, exfiltrate data, or bypass confirmation. This is inherent to letting
  a model consume server-supplied text — keep `write`/`destructive` tiers
  narrow and confirmation strict, and prefer `onlyTools` allowlists over
  registering everything a server exposes.
- **Confirm only from validated args.** Confirmation UI must be rendered from
  the schema-validated `PendingCall.args`, never from raw model or
  server-supplied text. The executor validates before confirming, so the args
  you render are well-formed — don't re-render unvalidated server content in a
  confirm dialog.
- **Don't ship long-lived secrets to the browser.** `apiKey` is sent as
  `Authorization: Bearer …` and is visible to the page (and to anything with
  access to the page's memory). For servers requiring user-scoped access,
  prefer `authProvider` (OAuth) so tokens are obtained and refreshed per user
  with a defined lifetime, rather than baking a shared key into the bundle.
- **Always use HTTPS.** Connect to `https://` endpoints only. Plain HTTP leaks
  the bearer token, tool arguments, and tool results; it also lets a
  network attacker tamper with the tool list and results the agent acts on.
- **Bound resource use.** Set a sane `requestTimeoutMs` so a hung or slow
  server can't stall a run indefinitely — the timeout covers the connect
  handshake, `listTools`, and each `callTool`. Aborting the parent run (the
  `AbortSignal` threaded in via `ToolContext`) cancels in-flight MCP calls.
- **Atomic registration.** The `hasConfirmation` preflight runs before any
  tool is registered, and a partial-registration failure rolls back already
  registered tools — so a tier mismatch never leaves a half-registered
  server whose tools the model could already call. Keep `hasConfirmation: true`
  whenever any tool can be `write`/`destructive`.
- **OAuth token storage is yours to harden.** The SDK calls your
  `OAuthClientProvider` for token persistence; the demo uses `localStorage`,
  which is reachable by any script on your origin (XSS). For real deployments,
  store tokens somewhere less XSS-exposed and scope them per server name.

## Tests

```bash
pnpm install
pnpm --filter @forgewisp/mcp test   # vitest run
```

The adapter is layered so the mapping is unit-testable without a network:
`adaptMcpTool` / `adaptMcpTools` are pure given a `McpClient` (a plain fake
implementing `callTool` is enough). `register-mcp-server.test.ts` and
`oauth.test.ts` use the SDK's `InMemoryTransport` via an `@internal`
`options.transport` injection seam on `createMcpTools` / `registerMcpServer`
(a `Transport` or a `() => Transport` factory — the factory form lets the
OAuth tests share one in-memory pipe across the gated transports that
`finishAuth`/resume build). This seam is not part of the stable public
contract.

## License

MIT