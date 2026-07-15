# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Forgewisp is a TypeScript library (`@forgewisp/core`) that lets browser apps register their own
functions as tools for an AI agent, with JSON Schema validation, a risk-tier execution model
(`read` / `write` / `destructive`), OpenAI-compatible streaming, a dual reasoning stream, and an
audit log. It runs entirely in the browser with no mandatory backend. A companion package
(`@forgewisp/bundled-tools`) ships a catalog of ready-to-register browser-effects tools, and an
opt-in package (`@forgewisp/mcp`) adapts tools from an MCP server (Streamable HTTP) into
`FunctionDefinition`s. Two vanilla-TS demos exercise the library: a task manager (`apps/demo`)
and a bundled-tools showcase (`apps/bundled-demo`).


## Cross-session progress

A `PROGRESS.md` may exist at the repo root (it is gitignored, so it stays local and is never
committed). When present, **read it first** before starting work — it is a running log of
in-progress changes, what's verified, what's pending, and gotchas carried across sessions.
Append a new dated entry to the top when you finish a chunk of work so the next session can pick
up where you left off. Do not commit it.


## Commands

Run from the repo root. This is a pnpm + Turborepo monorepo (`packages/*`, `apps/*`).

```bash
pnpm install          # install (use --frozen-lockfile in CI)
pnpm build            # turbo run build  (tsup for core, vite for demo)
pnpm test             # turbo run test   (vitest)
pnpm lint             # turbo run lint   (eslint, type-checked)
pnpm typecheck        # turbo run typecheck (tsc --noEmit)
pnpm dev              # turbo run dev --parallel — core tsup --watch + demo vite
pnpm format           # prettier --write .
pnpm format:check     # prettier --check .  (run in CI before lint)
```

The demo dev server runs on **http://localhost:5173** (Vite default; the README's `:3000` is
stale). On first load it prompts for an LLM endpoint, model, and optional API key, persisted to
`localStorage` under `forgewisp.demo.config`.

The docs site (`apps/docs`, Docusaurus) dev server runs on **http://localhost:3000** via the same
`pnpm dev`. It is **excluded from the main `pnpm build`** in CI (see `ci.yml`'s
`--filter=!forgewisp-docs`) to keep PR CI lean; it is built + deployed by `deploy-docs.yml`. To work
on docs in isolation: `cd apps/docs && pnpm dev` (auto-runs `gen:api` first) or `pnpm build`.

### Running things in a single package

Turbo forwards each script to the package. Work inside a package directory for targeted runs:

```bash
cd packages/core
pnpm test            # vitest run
pnpm test:watch      # vitest
pnpm build           # tsup (emits dist/index.mjs, .cjs, .global.js + .d.ts)
pnpm typecheck       # tsc --noEmit
pnpm lint            # eslint --config ../../eslint.config.mjs src tests
```

### Run a single test

```bash
# one file
pnpm --filter @forgewisp/core exec vitest run tests/streaming.test.ts
# by name pattern
pnpm --filter @forgewisp/core exec vitest run -t "routes tag content"
```

The core test environment is `node`; the demo tests use `jsdom` + `@testing-library/dom` with
`globals: true`. Note `packages/core/vitest.config.ts` has V8 coverage configured but `coverage`
is not run by the default `test` script.

## Architecture

### `@forgewisp/core` — the library

The public surface is intentionally tiny: `createAgent(config)` plus the types re-exported from
`src/index.ts`. The `ForgewispAgent` class itself is **not exported** — the type is obtained via
`ReturnType<typeof createAgent>`. Don't add new exports casually; consumers depend only on
`src/types.ts`.

The agent is a thin facade. The real flow is a pipeline of single-purpose modules in
`packages/core/src/`:

- **`agent.ts`** — `ForgewispAgent`. Owns the config, a `FunctionRegistry`, an `AuditLog`, and an
  `HttpClient`. `run(userMessage, signal?)` delegates to `loop.runToolLoop`. `registerFunction`
  enforces a key invariant: registering a `write`/`destructive` tool **throws at registration
  time** if `onConfirmRequired` is not configured.
- **`loop.ts`** — `runToolLoop`. Pure orchestration: drives the chat → tool-call → chat loop
  until the model returns a final response (no `tool_calls`) or `maxToolRounds` (default 10) is
  hit. HTTP and tool execution are injected via `ToolLoopDeps`, which is how the tests stub the
  LLM. Accumulates reasoning across rounds; serializes tool results back into the message history
  (non-serializable handler results are caught and replaced with a placeholder + audit event).
- **`registry.ts`** — `FunctionRegistry`. Map of registered functions; caches the OpenAI-shaped
  `tools` array (`toLLMTools`) and invalidates the cache on register/deregister.
- **`validator.ts`** — `validateArgs` via Ajv. Compiled validators are cached in a `WeakMap`
  keyed by the schema object, so repeated calls for the same tool are cheap. Ajv is constructed
  with `strict: false`.
- **`executor.ts`** — `executeToolCalls`. Two-phase: a synchronous pre-pass does lookup / JSON
  parse / `validateArgs` and emits `function_requested` / `validation_*` audit events in input
  order; validated calls then run confirmation + handler **concurrently** via `Promise.allSettled`.
  Each concurrent call buffers its audit events and the post-await flush re-emits them in input
  order, so the audit log preserves call order even when later calls finish first. `read`-tier
  tools skip confirmation; `write`/`destructive` call `config.onConfirmRequired` with a
  `PendingCall` whose `args` are **always schema-validated, never raw LLM output**.
- **`streaming.ts`** — `streamCompletion`, the OpenAI SSE parser. Handles three things: text
  deltas, tool-call fragment accumulation (assembled by index at the end), and reasoning. For
  `tag-based` reasoning it scans deltas in real time, routing content inside `<tag>…</tag>` to
  `onReasoningChunk` and outside to `onTextChunk`, buffering partial tag markers that straddle
  chunk boundaries (`longestSuffixPrefix`). For `extended` (o1/o3) reasoning the API only returns
  a `reasoning_tokens` count (no streamed text), surfaced as an annotation. Accumulates text in
  arrays + `join('')` to avoid O(n²) concat, but still fires per-chunk callbacks for real-time UX.
- **`http.ts`** — `HttpClient`. Builds the OpenAI-compatible request body, sends `Authorization`
  only when an `apiKey` is set (so proxied/no-auth endpoints work), and merges the per-request
  timeout with an external `AbortSignal` into one signal. Sets `stream_options.include_usage` for
  reasoning_tokens.
- **`audit.ts`** — `AuditLog`. Bounded ring (default 1000 events, oldest dropped). Optional
  `redact` runs **before** storage and before `onEvent`. A throwing `onEvent` is caught and
  recorded as `audit_callback_errored` — audit callbacks must never break the tool loop.
- **`wire.ts`** — internal OpenAI-compatible types (`LLMMessage`, `LLMToolCall`, `OpenAIChunk`).
  Deliberately **not re-exported** from the entry point.

### `apps/demo` — the demo

Vanilla TS + Vite. `src/main.ts` wires the agent end-to-end: a config overlay (endpoint/model/
key), a chat form with streaming output, a `<thinking>`-tag reasoning panel, and a confirmation
dialog rendered from validated args. Tools (`listTasks`, `addTask`, `markTaskDone`, `deleteTask`)
are defined table-driven in a `TOOLS` array and registered at agent build time.

**Security invariant in the demo:** every sink that turns model- or user-adjacent text into HTML
goes through DOMPurify (helpers in `src/render.ts`). The model can return arbitrary markdown
including raw HTML; without sanitization, `<img src=x onerror=…>` would execute. Don't bypass
`renderMarkdown` / `renderArgsHtml` / `escapeHtml` when adding new UI.

### `@forgewisp/bundled-tools` — the tool catalog

A workspace package shipping ready-to-register `FunctionDefinition` tools (no handler-arg casts:
the `defineTool<TArgs>` identity helper infers them). The barrel `src/index.ts` exports
`BUNDLED_TOOLS`, a readonly array grouped `read` → `write` → `destructive`, plus per-tool named
re-exports (values + `Args`/`Result` types). One file per tool in `src/tools/`, each with a strict
JSON Schema (`additionalProperties: false`, bounded strings/numbers, `enum` only for closed sets)
and a handler that guards missing Web-Platform APIs and throws a clear `Error` (→ `function_errored`).
`src/eval-math.ts` is an internal safe math evaluator (shunting-yard, **no `eval`/`Function`**,
closed grammar, `Number.isFinite` overflow check) — imported only by `evaluate-math.ts` and its
test, deliberately not re-exported. The only runtime dep is `@forgewisp/core` (validation runs in
core). Tools cover: time/UUIDs/safe-math/hashing/base64/viewport/battery/localStorage
(`read`), clipboard/speech/download/geolocation/localStorage-set (`write`), and
localStorage-remove (`destructive`). Async handlers are supported via the executor's
`await Promise.resolve(handler(args))`.

**Tier discipline is a security boundary here too:** `write`/`destructive` tools require the
consumer to configure `onConfirmRequired` (core throws at registration time otherwise). Consumers
must never render confirmation UI from raw LLM output — only from the schema-validated
`PendingCall.args`.

### `@forgewisp/mcp` — MCP server adapter

An opt-in workspace package that connects to an MCP server over the **Streamable HTTP** transport
and adapts its tools into `FunctionDefinition`s registered through the agent's existing
`registerFunction` path — so core's registry, Ajv validation, two-phase executor,
`onConfirmRequired` invariant, audit log, and `runToolLoop` all apply to MCP tools unchanged. **Core
is not modified by this package** and is a types-only/peer dependency here (the adapter builds plain
`FunctionDefinition` literals and hands them to the caller-provided agent's already-public
`registerFunction`/`deregisterFunction`; it never instantiates a core class). The only runtime dep
it adds is `@modelcontextprotocol/sdk` — isolating it in this package keeps users who don't need MCP
from pulling the SDK into their bundle.

Public surface (`src/index.ts`): `registerMcpServer(agent, config): Promise<McpServerHandle>` and
`createMcpTools(config, options?): Promise<McpToolsResult>` (the lower-level, agent-free form), plus
`McpServerConfig`/`McpServerHandle`/`McpAuthState`/`McpConnectOptions`/`McpToolsResult`/`AgentLike`
types, type-only re-exports from core, and type-only OAuth re-exports from the SDK
(`OAuthClientProvider` from `client/auth.js`; `OAuthTokens`/`OAuthClientMetadata`/
`OAuthClientInformationMixed` from `shared/auth.js` — those sub-types live in `shared/auth.js`, not
`client/auth.js`). `AgentLike` is a structural `{ registerFunction; deregisterFunction }` subset that
`ReturnType<typeof createAgent>` satisfies — the package never imports the not-exported
`ForgewispAgent` class. The adapter internals (`adaptMcpTool`/`adaptMcpTools`/`connectMcpServer`/
`connectClient`/`buildTransport`/`listAndAdapt`/`preflightAndRegister`) live in `src/mcp.ts` and are
not re-exported.

**OAuth 2.1 + PKCE.** `McpServerConfig.authProvider?: OAuthClientProvider` drives the SDK's
discovery (RFC 9728/8414/7591), PKCE, token-exchange, and refresh via
`StreamableHTTPClientTransport`'s `authProvider` option; the consumer implements the provider and
owns browser-redirect plumbing + token storage. `authProvider` takes precedence over `apiKey` (the
two are mutually exclusive — if both are set, `authProvider` wins and `apiKey` is ignored). The
consumer-visible state machine is `McpAuthState = 'authorized' | 'pending'`:
- A first connect that needs auth returns `authState: 'pending'` with empty tools instead of
  throwing — the handle/result stays alive with a `finishAuth(authorizationCode): Promise<void>`
  method. The consumer redirects the user to the authorization server (the SDK has already called
  `provider.redirectToAuthorization` before surfacing `pending`), then calls `finishAuth(code)` once
  the redirect-back arrives.
- **Fresh transport on resume.** `finishAuth(code)` is *not* "reconnect the spent transport." The
  SDK's `Client.connect` catches the `UnauthorizedError` thrown during the redirect, calls
  `void this.close()` (which aborts the transport's `_abortController` but does **not** null it),
  and rethrows — so a second `start()` on that transport throws `"already started"`. The same
  transport cannot be re-`connect`ed. So `finishAuth(code)` exchanges the code on the spent transport
  (its `finishAuth` only calls `auth()`, independent of `start()`) to save tokens into the provider,
  disconnects the spent client, builds a **fresh** transport whose `connect` reads
  `provider.tokens()` and succeeds, then re-lists tools and splices them into the caller's `tools`
  array in place. The same fresh-transport pattern backs `McpConnectOptions.authorizationCode` (the
  page-reload resume path: exchange the code on a fresh transport *before* connecting).
- `client/auth.js` (and its `UnauthorizedError`) is **dynamically imported only on the OAuth path**
  — non-OAuth consumers never load the auth module, so it lands in its own dynamic-import chunk
  (Vite emits a separate `auth-*.js` alongside `streamableHttp-*.js`). `UnauthorizedError` is
  matched with `instanceof` (the SDK gives it no custom `.name`, so a name check fails).
- `registerMcpServer` **defers the preflight** when `authState === 'pending'` (no tools to tier yet);
  the handle's `finishAuth` runs the `hasConfirmation` preflight *after* listing tools, then
  registers — and on preflight failure deregisters anything already registered, disconnects, and
  throws the same clear error (mirroring the non-pending preflight semantics). `createMcpTools`
  returns a `McpToolsResult` (`tools`/`authState`/`close`/`finishAuth`) whose `close`/`finishAuth` are
  arrow properties (so they destructure cleanly).

Key invariants, all enforced in `src/mcp.ts`:
- **Risk tiers come from config, not MCP hints.** MCP has no tier concept. `McpServerConfig.defaultTier`
  (default `read`) + `tierOverrides` map per original tool name. MCP `annotations.readOnlyHint`/
  `destructiveHint` are informational only and deliberately NOT auto-mapped — the consumer owns the
  security boundary.
- **Confirmation preflight.** `registerMcpServer` resolves all tool tiers *before* registering
  anything; if any maps to `write`/`destructive` and `config.hasConfirmation` is not `true`, it closes
  the client and throws a clear error (no partial registration). Core's own registration-time
  invariant still fires as a backstop inside `agent.registerFunction`.
- **Schema pass-through.** MCP `inputSchema` is full draft-07; core's `JSONSchema` type is a narrow
  subset that is NOT widened. The adapter casts the raw `inputSchema` to `JSONSchema` at the
  boundary — runtime is correct because core's Ajv is `strict: false` and the wire payload to the LLM
  carries the full schema.
- **Name namespacing.** Registered names are `${prefix}__<sanitized>`, sanitized to OpenAI's
  `^[A-Za-z0-9_-]{1,64}$`, with numeric suffixes on collision.
- **Result flattening.** MCP `callTool` results are reduced to a single JSON-serializable value
  (`structuredContent` preferred, then single text, then joined text, else `{ content }`); `isError`
  throws so the executor records `function_errored`.
- **Abort.** The parent run's `AbortSignal` (threaded in via `ToolContext`) is forwarded to
  `client.callTool`, merged with a per-server `requestTimeoutMs`.
- **Build:** ESM + CJS only (no IIFE/global build — inlining the MCP SDK into a self-contained global
  would be heavy and fragile, since it relies on browser-native `fetch`/`EventSource`). Consumers
  bundle it through their app bundler, which resolves the externalized SDK and peer core.

`StreamableHTTPClientTransport` is loaded via dynamic import inside `connectMcpServer` so the
transport module is only evaluated when actually connecting over HTTP; `client/auth.js` (and
`UnauthorizedError`) is dynamically imported only on the OAuth-pending path. Tests use the SDK's
`InMemoryTransport` via an `@internal` `transport` injection seam on `createMcpTools`/
`registerMcpServer` (a `Transport` or a `() => Transport | Promise<Transport>` factory — the factory
form lets the OAuth tests share one in-memory pipe across the gated transports that
`finishAuth`/resume build); this seam is not part of the stable public contract.

### `apps/bundled-demo` — the bundled-tools showcase

Vanilla TS + Vite, structurally identical to `apps/demo` (same config overlay, chat form, streaming,
reasoning panel, FIFO confirm queue, race guard, conversation threading, DOMPurify sanitization).
Differences: it registers **all** of `BUNDLED_TOOLS` instead of inline task tools, renders a
toolkit sidebar (`renderToolsList`, tier-grouped) and an artifacts panel fed by `onAuditEvent`
(`renderArtifact` dispatches on `event.functionName`; the geolocation OSM link `href` is built from
`Number(lat)`/`Number(lng)` + `escapeHtml` so no payload can break the attribute). The
`renderMarkdown` DOMPurify allowlist (`['href','title']`) is shared and **must not grow**;
`renderToolsList`/`renderArtifact` use their own local allowlists. Because `BUNDLED_TOOLS` is a
heterogeneous tuple, `main.ts` erases it once with `as unknown as readonly FunctionDefinition[]`
(handler contravariance workaround) and `renderToolsList` takes a structural `ToolMeta` subset.
Vite resolves `@forgewisp/bundled-tools` via the workspace symlink to its `dist/`, so build/watch
the package before running the demo's `dev`.

### `apps/mcp-demo` — the MCP adapter showcase

Vanilla TS + Vite, structurally identical to `apps/bundled-demo` (same config overlay, chat form,
streaming, reasoning panel, FIFO confirm queue, race guard, conversation threading, DOMPurify
sanitization) but **MCP-only**: it registers no inline or bundled tools — every tool comes from a
connected MCP server. A sidebar **MCP Servers** panel lets the user connect/disconnect one or more
Streamable-HTTP MCP servers at runtime (`#mcp-form` collects name/url/apiKey/`defaultTier`/
optional `requestTimeoutMs` plus a **Use OAuth** checkbox `#mcp-oauth`; `#mcp-servers-list` shows
connected-server chips with Disconnect buttons; `#mcp-status` is an `aria-live` status line).
`main.ts` uses the lower-level `createMcpTools(config, options?)` (not `registerMcpServer`) because
it returns the adapted `FunctionDefinition[]` — with `name`/`description`/`riskTier` — so the
tier-grouped `renderToolsList` can render them, while still yielding a `close()` for disconnect and
a `finishAuth(code)` for OAuth. Each connect passes `hasConfirmation: true` (the demo wires
`onConfirmRequired`, so the package's preflight never trips and core's registration-time invariant
is the backstop); `buildAgent` calls `disconnectAllServers()` so a rebuild drops prior servers
(their tools were on the old agent instance). Server chips are built with the DOM API (not
innerHTML) so a remote server/tool name can never break an attribute; `renderToolsList` keeps its
own local DOMPurify allowlist. The shared `renderMarkdown` allowlist (`['href','title']`) **must
not grow**. There is no per-function artifacts panel (MCP-agnostic; the generic audit log covers
activity). Vite resolves `@forgewisp/mcp` via the workspace symlink to its `dist/` (the SDK is
externalized by the package's tsup config and isolated in its `node_modules` by pnpm — the
production build emits separate `streamableHttp-*.js` and `auth-*.js` dynamic-import chunks), so
build/watch `@forgewisp/mcp` before running the demo's `dev`.

**OAuth wiring.** `src/oauth.ts` ships `LocalStorageOAuthProvider` (an `OAuthClientProvider`
backed by `localStorage` under `forgewisp.mcp.oauth.<serverName>`, with
`redirectUrl = ${origin}/oauth-callback.html`, RFC 7591 dynamic-registration storage, PKCE verifier
persistence, and a `state()`/`getActiveState()` correlation id). The static
`apps/mcp-demo/oauth-callback.html` is the provider's `redirectUrl`: it reads `code`+`state` from
`location.search` and, when opened as a popup (`window.opener`), `postMessage`s them to the opener
on `location.origin` and closes; with no opener (popup blocked) it `location.replace`s back to the
app root preserving the params (same-tab fallback). `main.ts` keeps a `Map<state, PendingAuth>` of
pending OAuth connects, validates `event.origin === location.origin` + `msg.type ===
'forgewisp-mcp-oauth'` on the `message` listener before calling `handle.finishAuth(code)`, and on
boot runs a load-resume path via `createMcpTools(config, { authorizationCode: code })` (cleaning
the URL with `history.replaceState`). Pending server configs are stashed in `localStorage` under
`forgewisp.mcp.oauthPending.<state>` so the same-tab resume can rebuild them. Disconnecting clears
the pending entry and the provider's stored tokens (`LocalStorageOAuthProvider.clear`).

### `apps/docs` — the Docusaurus documentation site

Docusaurus 3 (TypeScript config), deployed to GitHub Pages as a **project page** at
`https://forgewisp.github.io/forgewisp-core/` (`url` + `baseUrl: '/forgewisp-core/'`,
`trailingSlash: false`). Covers the three published packages (`@forgewisp/core`,
`@forgewisp/bundled-tools`, `@forgewisp/mcp`) — the demos are deliberately not documented as
sections. Unversioned. Custom-themed: a forge/ember Infima palette in `src/css/custom.css` (light +
dark) and a hand-written hero/features/packages landing in `src/pages/index.tsx` +
`index.module.css`; the logo/favicon/social-card are SVGs in `static/img/`.

**API reference is generated, not hand-written.** `pnpm gen:api` runs TypeDoc (`typedoc.*.json`)
with `typedoc-plugin-markdown` over each package's `src/index.ts` (entry-point strategy `resolve` →
public exports only) into `docs/{core,bundled-tools,mcp}/api/*.md`. `gen:api` is a `predev`/`prebuild`
hook, so `dev`/`build` always regenerate first. Generated `api/*.md` are **gitignored**; only the
committed `_category_.json` in each api dir persists (typedoc doesn't clear the `out` dir, so it
survives regen). The sidebars reference them via `{ type: 'autogenerated', dirName: '<pkg>/api' }`.

**The MDX sanitizer.** Docusaurus compiles every `.md` as MDX, which parses bare `{...}` as a JS
expression and `<X>` as JSX — both fatal. The package TSDoc also has 2-space-indented code examples
(not a CommonMark 4-space code block) that reach the prose pipeline. `scripts/sanitize-api-md.mjs`
runs after every `gen:api` to (1) convert indented code runs into fenced ```` ```ts ```` blocks and
(2) escape `{`/`}`/`<` in prose (outside fenced + inline code). It only touches `docs/**/api/*.md`,
never the hand-written guides. If a generated API page fails the build with an acorn/MDX error, the
fix belongs in the sanitizer, not in the package source.

**Cross-package type resolution.** `typedoc.tsconfig.json` path-maps `@forgewisp/core`/
`bundled-tools`/`mcp` to their `src/index.ts` so TypeDoc resolves workspace types without needing a
prior `build` (the package `package.json` `types` point at gitignored `dist/`). The MCP SDK
(`@modelcontextprotocol/sdk`) resolves through `node_modules` from the entry file's dir (pnpm
isolates it under `packages/mcp`); the OAuth cross-link warnings TypeDoc emits are harmless.

**`"type": "module"` must stay OFF here.** Unlike the Vite demo apps, `apps/docs/package.json` has
no `"type": "module"` — Docusaurus's webpack infra (`require.resolveWeak`) needs ambiguous/CJS
module mode; setting it makes `docusaurus build` fail at the server-bundle stage with
`TypeError: require.resolveWeak is not a function`. The `.mjs` sanitizer is ESM regardless.

**CI/deploy split.** `ci.yml` builds with `--filter=!forgewisp-docs` so PRs don't pull the
Docusaurus/TypeDoc toolchain. `deploy-docs.yml` (on push to `main` touching docs/packages) builds
with `--filter=forgewisp-docs...` (includes the three workspace deps so TypeDoc resolves), uploads
`apps/docs/build`, and deploys to Pages. The docs app defines **no** `lint`/`typecheck`/`test`
scripts, so `turbo run lint|typecheck|test` skip it automatically; `format:check`/`format` still
cover it (but `*.md` is in `.prettierignore`, so generated + hand-written markdown is untouched —
only the `.ts`/`.tsx`/`.css`/`.json`/`.yml` are formatted).

## Conventions worth knowing

- **Risk tiers are a security boundary, not a UX nicety.** Confirmation UI is always rendered
  from validated args, never from LLM-generated text. Preserve this when touching the executor or
  the demo's confirm dialog.
- **TypeScript is strict** (`tsconfig.base.json`): `strict`, `noUncheckedIndexedAccess`,
  `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`. Code must typecheck cleanly.
- **ESLint is type-checked** (`eslint.config.mjs`, `recommendedTypeChecked` with
  `projectService`). `no-floating-promises`, `await-thenable`, and `no-misused-promises` are
  errors — awaited promises must be handled, not dropped. `no-explicit-any` is a warning.
- **Formatting:** Prettier with single quotes, semis, trailing-comma `all`, 100-col, 2-space.
  `*.md` is in `.prettierignore`.
- **CI (`.github/workflows/ci.yml`)** runs `format:check`, `lint`, `typecheck`, `build`, `test`
  with `pnpm install --frozen-lockfile`. Releases (`release.yml`) are tag-driven (`v*`), verify
  the tag matches **all three** of `packages/core/package.json`,
  `packages/bundled-tools/package.json`, and `packages/mcp/package.json` (they version in lockstep),
  then publish `@forgewisp/core`, `@forgewisp/bundled-tools`, and `@forgewisp/mcp` to npm in that
  order (each later one via `pnpm publish`, which rewrites its `workspace:*` dependency on core to
  the resolved version) — so bumping all three package versions must accompany a release tag.
- The only runtime dependency in `@forgewisp/core` is `ajv`. Keep the dep surface minimal.
  (`@forgewisp/mcp` is the deliberate exception: it adds `@modelcontextprotocol/sdk`, which is why
  MCP support lives in a separate opt-in package rather than core.)