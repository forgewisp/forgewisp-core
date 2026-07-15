---
sidebar_position: 1
---

# @forgewisp/bundled-tools

A catalog of ready-to-register `FunctionDefinition` tools — browser effects like clipboard,
geolocation, UUIDs, hashing, base64, QR codes, color conversion, and more. Forgewisp-ready and safe
by default. The only runtime dependency is `@forgewisp/core` (validation runs in core).

```bash npm2yarn
npm install @forgewisp/core @forgewisp/bundled-tools
```

## Register the whole catalog

```ts
import { createAgent } from '@forgewisp/core';
import { BUNDLED_TOOLS } from '@forgewisp/bundled-tools';

const agent = createAgent({
  model: 'gpt-4o-mini',
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: import.meta.env.VITE_OPENAI_API_KEY,
  onConfirmRequired: async (call) => showConfirm(call), // required: catalog has write/destructive tools
});

for (const tool of BUNDLED_TOOLS) {
  agent.registerFunction(tool);
}
```

`BUNDLED_TOOLS` is a readonly array grouped `read` → `write` → `destructive`, so iterating it
registers safe tools first. You can also import individual tools by name:

```ts
import { getCurrentTime, generateUuid, evaluateMath, hashText } from '@forgewisp/bundled-tools';
```

## Define your own the same way

`defineTool<TArgs>(...)` is the identity helper the catalog uses — it infers `TArgs` from the
**handler's argument signature** (the JSON Schema carries no type info), so there are no handler-arg
casts. Annotate the handler's argument so the inference has a type to read:

```ts
import { defineTool } from '@forgewisp/bundled-tools';

const echo = defineTool({
  name: 'echo',
  description: 'Echo a string back',
  riskTier: 'read',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { message: { type: 'string', minLength: 1 } },
    required: ['message'],
  },
  handler: async ({ message }: { message: string }) => message, // message: string
});
```

## What's in the catalog

Each tool ships a **strict** JSON Schema (`additionalProperties: false`, bounded strings/numbers,
`enum` only for closed sets) and a handler that guards missing Web-Platform APIs and throws a clear
`Error` (→ `function_errored` audit event) instead of crashing.

| Tier | Tools |
| --- | --- |
| `read` | time, UUIDs, safe math, hashing, base64 (encode/decode), viewport, battery, color conversion, QR codes, localStorage keys/get, session storage keys/get, plan management (list/get/create/add-item/update-item/remove-item/delete) |
| `write` | clipboard, speech, download, geolocation, localStorage set, session storage set, vibrate, share, wake lock |
| `destructive` | localStorage remove, clear localStorage, session storage remove |

Async handlers are supported (the executor does `await Promise.resolve(handler(args))`).

## Safe math, no `eval`

`evaluateMath` uses an internal shunting-yard evaluator (`eval-math.ts`) with a closed grammar and a
`Number.isFinite` overflow check — **no `eval`, no `Function`**. It's imported only by the
`evaluate-math` tool and its test, and deliberately not re-exported.

## Tier discipline applies here too

`write`/`destructive` tools require the consumer to configure `onConfirmRequired` (core throws at
registration time otherwise). And, as always, **never render confirmation UI from raw LLM output** —
only from the schema-validated `PendingCall.args` core hands you.

The generated API reference for every tool and its `Args`/`Result` types is at the bottom of this
sidebar section.