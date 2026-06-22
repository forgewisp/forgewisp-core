# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Forgewisp is a TypeScript library (`@forgewisp/core`) that lets browser apps register their own
functions as tools for an AI agent, with JSON Schema validation, a risk-tier execution model
(`read` / `write` / `destructive`), OpenAI-compatible streaming, a dual reasoning stream, and an
audit log. It runs entirely in the browser with no mandatory backend. A vanilla-TS task-manager
demo (`apps/demo`) exercises it.


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
  the tag matches `packages/core/package.json` version, then publish `@forgewisp/core` to npm with
  provenance — so bumping the package version must accompany a release tag.
- The only runtime dependency in `@forgewisp/core` is `ajv`. Keep the dep surface minimal.