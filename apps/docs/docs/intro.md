---
sidebar_position: 1
---

# Introduction

**Forgewisp** is a TypeScript library that lets browser apps register their own functions as
tools for an AI agent — with JSON Schema validation, a risk-tier execution model, OpenAI-compatible
streaming, a dual reasoning stream, and an audit log. It runs entirely in the browser with no
mandatory backend.

Forgewisp ships as three packages:

| Package | What it is |
| --- | --- |
| [`@forgewisp/core`](./core) | The library. `createAgent(config)` + a tiny typed surface. |
| [`@forgewisp/bundled-tools`](./bundled-tools) | A catalog of ready-to-register browser-effects tools. |
| [`@forgewisp/mcp`](./mcp) | An opt-in adapter that turns an MCP server's tools into agent tools. |

## Why

Most agent frameworks live on a server and call server-side tools. Forgewisp flips that: the tools
are the app's own functions, validated against a JSON Schema you control, and executed in the same
browser context the user already trusts. That means:

- **The tool surface is the app's surface.** No backend translates the model's intent into your
  domain — your functions are the tools, directly.
- **Risk tiers are a security boundary, not a UX nicety.** `write`/`destructive` tools require a
  confirmation callback, and the confirmation UI is always rendered from **schema-validated args**,
  never from model-generated text.
- **Everything is observable.** A bounded audit log records every request, validation, confirmation,
  and tool result, with optional redaction.
- **No mandatory backend.** You point the agent at any OpenAI-compatible endpoint (with an optional
  API key) and go.

## Where to start

- New here? Read [Installation](./getting-started/installation) then the
  [Quickstart](./getting-started/quickstart).
- Want the mental model? Read the [core overview](./core).
- Want prebuilt tools (clipboard, geolocation, hashing, QR…)? See
  [`@forgewisp/bundled-tools`](./bundled-tools).
- Want to pull tools from an MCP server? See [`@forgewisp/mcp`](./mcp).

## The 30-second tour

```ts
import { createAgent } from '@forgewisp/core';

const agent = createAgent({
  model: 'gpt-4o-mini',
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: import.meta.env.VITE_OPENAI_API_KEY,
  onConfirmRequired: async (call) => window.confirm(`Run ${call.functionName}?`),
});

agent.registerFunction({
  name: 'addTask',
  description: 'Add a task to the list',
  riskTier: 'write',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { title: { type: 'string', minLength: 1, maxLength: 200 } },
    required: ['title'],
  },
  handler: async ({ title }) => tasks.push({ title, done: false }),
});

const result = await agent.run('Add "buy milk" to my tasks');
```

The full API reference for each package is generated from source and linked at the bottom of its
section in the sidebar.