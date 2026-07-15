---
sidebar_position: 4
---

# Reasoning

Forgewisp supports a **dual stream**: assistant text and reasoning ("thinking") travel side by side,
so you can render a collapsible thinking panel alongside the answer.

## Modes

`streaming.reasoning.mode` selects how reasoning is extracted. There are four modes:

### `none`

The default. No reasoning separation; `onReasoningChunk` is never called. Use it when your model
doesn't emit reasoning, or you don't want a thinking panel.

```ts
createAgent({
  streaming: { reasoning: { mode: 'none' } },
});
```

### `tag-based`

The model emits reasoning inline, wrapped in a tag you choose (default `thinking`):

```
Here is my plan. <thinking>The user has 3 tasks, so I should list them first.</thinking> Let me…
```

The stream parser scans deltas in real time and routes:

- content **inside** `<thinking>…</thinking>` → `onReasoningChunk`
- content **outside** → `onTextChunk`

Crucially, the tag markers themselves are **not** delivered to either callback, and partial tag
markers that straddle a chunk boundary are buffered with a longest-suffix-prefix match so a `<thi`
arriving at the end of one chunk and `nking>` at the start of the next is correctly recognized
instead of leaking into your text. The tag is also stripped from the final `result.response`.

```ts
createAgent({
  streaming: { reasoning: { mode: 'tag-based', tag: 'thinking' } },
});
```

### `extended`

For OpenAI's o1/o3 family, the API does not stream reasoning text — it returns only a
`reasoning_tokens` count. Forgewisp surfaces that count as an annotation on the result. There's no
`onReasoningChunk` to call (there's nothing to stream); the value is still recorded on
`result.reasoning` so your UI can show "thought for N tokens".

```ts
createAgent({
  streaming: { reasoning: { mode: 'extended' } },
});
```

### `native`

Some servers stream reasoning in a **separate delta field** rather than wrapping it in a tag inside
the text: `reasoning` for Ollama, `reasoning_content` for vLLM/DashScope. In `native` mode Forgewisp
routes each reasoning delta straight to `onReasoningChunk` without scanning the text content, and
each text delta to `onTextChunk`. Use this when your provider emits a native reasoning field (it
avoids the overhead and ambiguity of tag-scanning).

```ts
createAgent({
  streaming: { reasoning: { mode: 'native' } },
});
```

## Accumulation

Reasoning is accumulated across **all** rounds of the tool loop, not just the final one — so if the
model thinks, calls a tool, then thinks again before answering, you get the concatenated reasoning.
`result.reasoning` carries the full accumulation.

## Choosing

- Use `none` (the default) when your model doesn't emit reasoning, or you don't want a thinking panel.
- Use `tag-based` when your model emits visible `<tag>` reasoning (many open-weight and proxied
  models do).
- Use `extended` when you're hitting o1/o3 through the OpenAI API.
- Use `native` when your provider streams reasoning in its own delta field (`reasoning` /
  `reasoning_content`).

See the API reference for `StreamingConfig`, `ReasoningMode`, and `AgentReasoning`.