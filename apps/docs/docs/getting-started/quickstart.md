---
sidebar_position: 2
---

# Quickstart

This walks through creating an agent, registering a couple of tools, and running a streaming loop —
the same shape the `apps/demo` task manager uses.

## 1. Create an agent

`createAgent(config)` is the only entry point. The agent class itself is not exported; name its type
with `ReturnType<typeof createAgent>`.

```ts
import { createAgent } from '@forgewisp/core';

const agent = createAgent({
  model: 'gpt-4o-mini',
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: import.meta.env.VITE_OPENAI_API_KEY, // optional for no-auth/proxied endpoints

  // Required the moment you register any write/destructive tool.
  onConfirmRequired: async (call) => {
    return window.confirm(`Run ${call.functionName} with ${JSON.stringify(call.args)}?`);
  },
});
```

:::note
`onConfirmRequired` is optional until you register a `write` or `destructive` tool — at which point
core **throws at registration time** if it's not configured. This is deliberate: confirmation UI is
a security boundary, not a nicety.
:::

## 2. Register tools

Each tool is a `FunctionDefinition`: a name, description, JSON Schema for its parameters, a
[`riskTier`](../core/risk-tiers), and a handler. The handler receives **schema-validated args** —
never raw LLM output.

```ts
const tasks: { title: string; done: boolean }[] = [];

agent.registerFunction({
  name: 'listTasks',
  description: 'List all tasks',
  riskTier: 'read',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => tasks,
});

agent.registerFunction({
  name: 'addTask',
  description: 'Add a task to the list',
  riskTier: 'write', // triggers onConfirmRequired
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { title: { type: 'string', minLength: 1, maxLength: 200 } },
    required: ['title'],
  },
  handler: async ({ title }) => {
    tasks.push({ title, done: false });
    return { ok: true };
  },
});
```

## 3. Run a turn

`run(userMessage, options?)` drives the chat → tool-call → chat loop until the model returns a final
response or `maxToolRounds` (default 10) is hit. `options` carries an optional `signal` (`AbortSignal`)
and `history` (prior chat turns).

```ts
const signal = AbortSignal.timeout(30_000);
const result = await agent.run('Add "buy milk" and then list my tasks', { signal });

console.log(result.response); // final assistant text
console.log(result.reasoning); // accumulated reasoning (if any)
```

## 4. Stream it

For real-time UX, configure `onTextChunk` / `onReasoningChunk` on the `streaming` field of your
`createAgent` config — they fire as chunks arrive during `run`. See
[Streaming](../core/streaming) for the full SSE contract.

```ts
const agent = createAgent({
  model: 'gpt-4o-mini',
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  streaming: {
    onTextChunk: (delta) => writeToDom(delta),
    onReasoningChunk: (delta) => writeToThinkingPanel(delta),
  },
});

await agent.run('Add "buy milk"');
```

## 5. Watch the audit log

Every request, validation, confirmation, and tool result is recorded. Subscribe via the
`audit.onEvent` config (fired per event, in order), or read the bounded log after the fact:

```ts
const agent = createAgent({
  model: 'gpt-4o-mini',
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  audit: {
    onEvent: (event) => console.log('[audit]', event.type, event),
  },
});

// ...after a run, read the whole bounded log:
const events = agent.getAuditLog();
```

See [Audit log](../core/audit) for the event taxonomy and redaction.

## Next

- [Core overview](../core) — the pipeline, the mental model.
- [Configuration](../core/configuration) — every knob.
- [Risk tiers](../core/risk-tiers) — the security model.
- The API reference is generated at the bottom of each package's sidebar section.