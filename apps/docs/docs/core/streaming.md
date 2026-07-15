---
sidebar_position: 3
---

# Streaming

Forgewisp parses the OpenAI Server-Sent Events stream directly — text deltas, tool-call fragment
accumulation, and reasoning — and fires per-chunk callbacks so your UI can render in real time
without buffering the whole response.

## Wiring callbacks

Chunk callbacks live on the `streaming` field of the agent's config, and fire during `run`:

```ts
const agent = createAgent({
  // ...
  streaming: {
    onTextChunk: (delta) => appendToDom(delta),
    onReasoningChunk: (delta) => appendToThinking(delta),
  },
});

await agent.run('Explain my tasks', { signal });
```

- `onTextChunk(delta)` — a fragment of assistant text. Deltas arrive in order; concatenate them for
  the full text. The agent also accumulates internally and returns `result.response` joined once at
  the end (it uses array + `join('')` internally, so no O(n²) concat cost).
- `onReasoningChunk(delta)` — a fragment of reasoning text (see [Reasoning](./reasoning)).

## Tool-call fragments

Tool calls can arrive split across many SSE chunks. The parser accumulates each call's `id`,
`name`, and `arguments` **by index** and only materializes a complete `tool_call` once its fragments
are assembled. You don't deal with partial JSON — by the time `executeToolCalls` runs, each call's
`arguments` is a complete string that gets JSON-parsed and schema-validated.

## Abort

Pass an `AbortSignal` to `run` (via `options.signal`). It's merged with the per-request HTTP timeout
into one signal, so aborting the run cancels in-flight HTTP immediately. Tool handlers also receive
the signal via `ToolContext` (so a long-running handler can bail), and subagents forward it to their
own runs.

## What's not streamed

For `extended`-mode reasoning (o1/o3), the API returns only a `reasoning_tokens` count, not streamed
text. Forgewisp surfaces that as an annotation rather than calling `onReasoningChunk` — there's
nothing to stream.

See [Reasoning](./reasoning) for the modes, and the generated API reference for the exact
callback signatures.