---
sidebar_position: 1
---

# Overview

`@forgewisp/core` is intentionally tiny: one factory (`createAgent`), a handful of types, and a
pipeline of single-purpose modules behind it. This page is the mental model; the rest of this
section expands each piece.

## The pipeline

The agent is a thin facade. `run(userMessage, options?)` delegates to a tool loop that orchestrates
five concerns, each isolated in its own module:

```
createAgent(config)
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  runToolLoop  (loop.ts) — chat → tool-call → chat, ≤N rounds │
│                                                             │
│   ┌────────────┐   ┌───────────┐   ┌──────────────────┐     │
│   │ HttpClient │──▶│ streaming │──▶│  text / reasoning│     │
│   │  (http.ts) │   │  (sse)    │   │  tool_call deltas│     │
│   └────────────┘   └───────────┘   └──────────────────┘     │
│          │                                                 │
│          ▼  if tool_calls                                  │
│   ┌─────────────────────────────────────────────┐          │
│   │ executeToolCalls (executor.ts)              │          │
│   │  1. lookup + JSON.parse + validateArgs       │          │
│   │     (registry.ts / validator.ts)            │          │
│   │  2. confirmation (read skips; write/         │          │
│   │     destructive → onConfirmRequired)        │          │
│   │  3. handlers run concurrently, results      │          │
│   │     serialized back into history in order   │          │
│   └─────────────────────────────────────────────┘          │
│          │                                                 │
│          ▼  audit events (audit.ts) at every step          │
└─────────────────────────────────────────────────────────────┘
```

## Module map

| Module | Responsibility |
| --- | --- |
| `agent.ts` | `ForgewispAgent` — owns config, registry, audit log, HTTP client. Enforces the registration-time invariant for `write`/`destructive`. |
| `loop.ts` | `runToolLoop` — pure orchestration; drives rounds until a final response or `maxToolRounds`. HTTP + tool exec are injected (this is how tests stub the LLM). |
| `registry.ts` | `FunctionRegistry` — map of tools; caches the OpenAI-shaped `tools` array, invalidated on register/deregister. |
| `validator.ts` | `validateArgs` via Ajv. Compiled validators cached in a `WeakMap` keyed by schema. |
| `executor.ts` | `executeToolCalls` — two-phase: sync pre-pass (lookup/parse/validate, audit in input order), then concurrent handler runs via `Promise.allSettled` with order-preserving audit flush. |
| `streaming.ts` | `streamCompletion` — OpenAI SSE parser: text deltas, tool-call fragment accumulation, dual reasoning stream. |
| `http.ts` | `HttpClient` — builds the request, merges per-request timeout with an external `AbortSignal`, sends `Authorization` only when an `apiKey` is set. |
| `audit.ts` | `AuditLog` — bounded ring (default 1000), optional `redact`, a throwing `onEvent` is caught and recorded. |
| `wire.ts` | Internal OpenAI-compatible types — deliberately **not re-exported**. |

## The public surface

Don't expect a large API. From `@forgewisp/core` you get:

- `createAgent(config)` — the factory.
- `defineToolSet(...)` — group tools into a named set.
- `createSubagentTool(config)` — declarative subagent orchestration (see [Subagents](/docs/core/subagents)).
- `HttpError`, `isHttpError` — structured HTTP errors for higher-level retry layers.
- A set of **types** (`ForgewispConfig`, `FunctionDefinition`, `RiskTier`, `JSONSchema`,
  `PendingCall`, `AuditEvent`, `AgentResult`, `StreamingConfig`, `ReasoningMode`, `ToolContext`, …).

The `ForgewispAgent` class is not exported; name its type with `ReturnType<typeof createAgent>`.

## Invariants worth preserving

- **Confirmation UI is rendered from validated args, never LLM text.** The `PendingCall.args` passed
  to `onConfirmRequired` are always schema-validated.
- **`write`/`destructive` registration throws without `onConfirmRequired`.** Fail fast, at build
  time, not on the first dangerous call.
- **Audit callbacks must never break the tool loop.** A throwing `onEvent` is caught and recorded.
- **Non-serializable handler results are caught** and replaced with a placeholder + audit event, so
  one bad tool can't poison the message history.

The rest of this section goes deeper on [configuration](/docs/core/configuration),
[streaming](/docs/core/streaming), [reasoning](/docs/core/reasoning), the [audit log](/docs/core/audit),
and [risk tiers](/docs/core/risk-tiers). The generated API reference lives at the bottom of this
sidebar section; see also [Subagents](/docs/core/subagents).