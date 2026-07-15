---
sidebar_position: 1
---

# Installation

Forgewisp is published to npm as three packages. Install the one you need; the catalog and MCP
adapter both peer-depend on core.

## Core only

```bash npm2yarn
npm install @forgewisp/core
```

The only runtime dependency is [`ajv`](https://ajv.js.org) — the schema validator. Nothing else is
pulled into your bundle.

## Core + the bundled tool catalog

```bash npm2yarn
npm install @forgewisp/core @forgewisp/bundled-tools
```

`@forgewisp/bundled-tools` ships ready-to-register browser-effects tools (time, UUIDs, safe math,
hashing, base64, viewport, battery, localStorage, clipboard, speech, download, geolocation, QR
codes, color conversion, …). It adds no runtime dependencies beyond core.

## Core + MCP adapter

```bash npm2yarn
npm install @forgewisp/core @forgewisp/mcp
```

`@forgewisp/mcp` adapts tools from an MCP server (Streamable HTTP) into agent
`FunctionDefinition`s. It adds `@modelcontextprotocol/sdk` — which is why MCP support lives in a
separate opt-in package rather than in core.

## Requirements

- **TypeScript ≥ 5.4** (Forgewisp is strict-typed; `noUncheckedIndexedAccess`-friendly).
- **Node ≥ 18** for tooling. At runtime Forgewisp targets modern browsers (it uses
  `fetch`, `AbortController`, `crypto.subtle`, etc. depending on the tools you register).
- A bundler that handles `workspace:`/ESM (Vite, esbuild, Rollup, Webpack 5+). The demos use Vite.

## Verify it typechecks

```ts
import { createAgent, type FunctionDefinition } from '@forgewisp/core';

const agent = createAgent({ model: 'x', llmEndpoint: 'x' });
const tool: FunctionDefinition = {
  name: 'noop',
  description: 'does nothing',
  riskTier: 'read',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => null,
};
agent.registerFunction(tool);
```

If that compiles, you're set. Head to the [Quickstart](./quickstart).