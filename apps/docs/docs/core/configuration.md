---
sidebar_position: 2
---

# Configuration

`createAgent` takes a `ForgewispConfig`. This page covers the knobs that matter; the full field list
is in the API reference.

## LLM endpoint

```ts
const agent = createAgent({
  model: 'gpt-4o-mini',
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: import.meta.env.VITE_OPENAI_API_KEY, // optional
});
```

- `llmEndpoint` — the full OpenAI-compatible chat-completions URL. It is used **verbatim**:
  forgewisp does not append `/chat/completions` (or any path) for you, so include it yourself, e.g.
  `https://api.openai.com/v1/chat/completions`.
- `apiKey` — sent as `Authorization: Bearer <key>` **only** when set. Omit it for proxied/no-auth
  endpoints (your own gateway that injects the key server-side).
- `model` — the model id to send.

## HTTP

The per-request timeout is a top-level knob; retry/backoff live under `http`:

```ts
createAgent({
  // ...
  requestTimeoutMs: 30_000, // per-request timeout (default 60000); 0 disables
  http: {
    maxRetries: 2, // attempts after the first (default 3); 0 disables retry
    retryableStatusCodes: [429, 503, 504], // default; plus network resets are always retried
  },
});
```

When both a per-request timeout and an external `AbortSignal` are present, `HttpClient` merges them
into a single signal — aborting the run aborts in-flight HTTP. The structured `HttpError` it throws
after exhausting retries (or immediately for a non-retryable status) is exported so a higher-level
layer can branch on `isHttpError(err)` / `err.isRetryable`. `http` also exposes `retryBackoffBaseMs`
(default 500) and `retryBackoffMaxMs` (default 8000).

## The tool loop

```ts
createAgent({
  // ...
  maxToolRounds: 10, // hard cap on chat → tool → chat iterations
});
```

When the cap is hit without a final response, the loop returns what it has with a marker — the model
can't runaway-loop your browser.

## Streaming

Reasoning mode and chunk callbacks both live on `streaming`. Reasoning is selected by the nested
`streaming.reasoning` object:

```ts
createAgent({
  // ...
  streaming: {
    reasoning: { mode: 'tag-based', tag: 'thinking' }, // or 'extended' / 'native' / 'none'
    onTextChunk: (delta) => appendToDom(delta),
    onReasoningChunk: (delta) => appendToThinking(delta),
  },
});
```

See [Streaming](./streaming) and [Reasoning](./reasoning) for the full SSE contract.

## Confirmation

```ts
createAgent({
  // ...
  onConfirmRequired: async (call) => {
    // call.args are schema-validated — safe to render.
    return await showConfirmDialog(call.functionName, call.args);
  },
});
```

Required the moment any `write`/`destructive` tool is registered. See
[Risk tiers](./risk-tiers).

## Audit

```ts
createAgent({
  // ...
  audit: {
    maxEvents: 1000, // bounded ring; oldest dropped
    onEvent: (event) => {
      // fired per event, in order (post-redaction)
      console.log(event.type, event);
    },
    redact: (event) => {
      /* return a sanitized copy, or the event unchanged */
    },
  },
});
```

`redact` runs **before** storage and before `onEvent`. Read the whole bounded log after a run with
`agent.getAuditLog()`. See [Audit log](./audit).

## Subagents

```ts
import { createSubagentTool } from '@forgewisp/core';

const researchTool = createSubagentTool({
  config, // the parent agent's ForgewispConfig (reused for the subagent)
  tools: [/* a focused pool of FunctionDefinitions */],
  // systemPrompt?, maxToolRounds? optional
});
agent.registerFunction(researchTool);
```

See [Subagents](./subagents) for the recursion guard and abort semantics.