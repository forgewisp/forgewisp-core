# `@forgewisp/bundled-tools`

[![GitHub stars](https://img.shields.io/github/stars/forgewisp/forgewisp-core?style=social)](https://github.com/forgewisp/forgewisp-core)
[![GitHub repo](https://img.shields.io/badge/repo-forgewisp%2Fforgewisp--core-blue)](https://github.com/forgewisp/forgewisp-core)
[![npm version](https://img.shields.io/npm/v/@forgewisp/bundled-tools.svg)](https://www.npmjs.com/package/@forgewisp/bundled-tools)
[![npm downloads](https://img.shields.io/npm/dw/@forgewisp/bundled-tools.svg)](https://www.npmjs.com/package/@forgewisp/bundled-tools)
[![CI](https://github.com/forgewisp/forgewisp-core/actions/workflows/ci.yml/badge.svg)](https://github.com/forgewisp/forgewisp-core/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@forgewisp/bundled-tools.svg)](https://github.com/forgewisp/forgewisp-core/blob/main/LICENSE)

> ⭐ **Found Forgewisp useful? [Star the repo](https://github.com/forgewisp/forgewisp-core) on GitHub.**

> A catalog of browser-safe, ready-to-register `FunctionDefinition` tools for
> [Forgewisp](https://github.com/forgewisp/forgewisp-core) agents — time, UUIDs,
> safe math, hashing, base64, color conversion, QR-code generation,
> viewport/battery/localStorage/sessionStorage reads, clipboard, speech,
> downloads, vibration, Web Share, screen wake lock, geolocation,
> localStorage/sessionStorage writes, and destructive
> localStorage/sessionStorage clears.

`@forgewisp/core` lets you register your own functions as agent tools. This
package ships a set of pre-built ones so you can give an agent real browser
capabilities in one `forEach`. Every tool ships with a strict JSON Schema
(`additionalProperties: false`, bounded strings/numbers, `enum` only for
closed sets) and a safe handler that guards missing Web-Platform APIs and
throws a clear `Error` on misuse (surfaced as a `function_errored` audit
event). The only runtime dependency is
[`@forgewisp/core`](https://www.npmjs.com/package/@forgewisp/core) — argument
validation runs there.

The safe-math tool (`evaluateMath`) uses an internal shunting-yard evaluator
with a closed grammar and an overflow check — **no `eval` / `Function`** — so
it is safe to expose to LLM-generated input.

## Install

```bash
pnpm add @forgewisp/bundled-tools @forgewisp/core
# or
npm install @forgewisp/bundled-tools @forgewisp/core
```

ESM, CommonJS, and full TypeScript definitions are shipped (`dist/index.mjs`,
`dist/index.cjs`, `dist/index.d.ts`). Node.js ≥ 18.

## Quick start

```ts
import { createAgent } from '@forgewisp/core';
import { BUNDLED_TOOLS } from '@forgewisp/bundled-tools';

const agent = createAgent({
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
  systemPrompt: 'You can read the time, do math, and save notes to localStorage.',
  // write/destructive tools require this — see "Risk tiers" below.
  onConfirmRequired: async (call) =>
    window.confirm(`${call.functionName}: ${JSON.stringify(call.args)}`),
});

// Register the whole catalog, or pick the ones you want (see "Catalog").
BUNDLED_TOOLS.forEach((def) => agent.registerFunction(def));

const result = await agent.run(
  'What time is it in Tokyo, and what is 17 * 23 + 4?',
);
```

## Catalog

Tools are grouped by tier (`read` → `write` → `destructive`), matching the
order of `BUNDLED_TOOLS`. Each is exported by name, with `Args` and `Result`
types, e.g. `import { getCurrentTime, type GetCurrentTimeResult }`.

### `read`

| Tool                 | Name                | Description                                                                |
| -------------------- | ------------------- | -------------------------------------------------------------------------- |
| `getCurrentTime`     | `getCurrentTime`    | Current date/time; optionally in a given IANA timezone.                     |
| `generateUuid`       | `generateUuid`      | A cryptographically-random UUID (v4) via `crypto.randomUUID`.             |
| `evaluateMath`       | `evaluateMath`      | Safe arithmetic (`+ - * / % ^`, parens, decimals, unary minus). No `eval`. |
| `hashText`           | `hashText`          | SHA-256/384/512 (Web Crypto `digest`, hex digest).                          |
| `encodeBase64`       | `encodeBase64`      | UTF-8 text → Base64 (unicode-safe).                                        |
| `decodeBase64`       | `decodeBase64`      | Base64 → UTF-8 text. Throws on invalid input.                              |
| `getViewportInfo`    | `getViewportInfo`   | Viewport + document size, scroll position, device pixel ratio.             |
| `getBatteryInfo`     | `getBatteryInfo`    | Battery level + charging state (where the Battery API exists).             |
| `convertColor`       | `convertColor`      | Convert between hex / rgb / hsl; auto-detects the input format.           |
| `generateQrCode`     | `generateQrCode`    | Encode text/URL as a QR code → PNG data URL (offscreen `<canvas>`).        |
| `listLocalStorageKeys` | `listLocalStorageKeys` | All keys in this origin's `localStorage`.                              |
| `getLocalStorageItem` | `getLocalStorageItem` | One `localStorage` value by key (`{ exists: false }` if absent).       |
| `listSessionStorageKeys` | `listSessionStorageKeys` | All keys in this tab's `sessionStorage` (per-tab; cleared on close). |
| `getSessionStorageItem` | `getSessionStorageItem` | One `sessionStorage` value by key (`{ exists: false }` if absent).     |

The catalog also includes seven **agent planning tools** — a job-tracking
scratchpad persisted in `localStorage` under `forgewisp.plans`. They are
`read`-tier **by exception** (agent-owned, bounded, schema-validated scratchpad
the agent self-manages, so no `onConfirmRequired` prompts):

| Tool             | Name             | Description                                                            |
| ---------------- | ---------------- | --------------------------------------------------------------------- |
| `listPlans`      | `listPlans`      | Summaries of all plans (id, title, status, counts).                   |
| `getPlan`        | `getPlan`        | One plan with its items.                                               |
| `createPlan`     | `createPlan`     | Create a plan with title/priority and initial items.                  |
| `addPlanItem`    | `addPlanItem`    | Append an item to a plan.                                              |
| `updatePlanItem` | `updatePlanItem` | Update an item's text/status/priority.                                |
| `removePlanItem` | `removePlanItem` | Remove an item from a plan.                                           |
| `deletePlan`     | `deletePlan`     | Delete a plan and its items.                                          |

### `write`

| Tool                 | Name                | Description                                                                |
| -------------------- | ------------------- | -------------------------------------------------------------------------- |
| `copyToClipboard`    | `copyToClipboard`   | Write text to the system clipboard (`navigator.clipboard`).                |
| `speakText`          | `speakText`         | Speak text aloud (`speechSynthesis`), with optional BCP-47 language.      |
| `downloadFile`       | `downloadFile`      | Trigger a file download; rejects filenames with path separators.          |
| `setLocalStorageItem` | `setLocalStorageItem` | Write a key/value to `localStorage`.                                     |
| `vibrateDevice`      | `vibrateDevice`     | Vibrate the device (`navigator.vibrate`) with a pulse pattern.            |
| `shareContent`       | `shareContent`      | Open the native share sheet (`navigator.share`); cancellation is not an error. |
| `requestWakeLock`    | `requestWakeLock`   | Acquire a screen wake lock (`navigator.wakeLock`); auto-releases on tab hide. |
| `setSessionStorageItem` | `setSessionStorageItem` | Write a key/value to `sessionStorage` (per-tab; cleared on close).    |
| `getGeolocation`     | `getGeolocation`    | Request a GPS fix (`navigator.geolocation`); user-prompted by the browser. |

### `destructive`

| Tool                   | Name                  | Description                              |
| ---------------------- | --------------------- | ---------------------------------------- |
| `removeLocalStorageItem` | `removeLocalStorageItem` | Delete a key from `localStorage`.        |
| `clearLocalStorage`    | `clearLocalStorage`    | Clear **all** keys from `localStorage` (high blast radius). |
| `removeSessionStorageItem` | `removeSessionStorageItem` | Delete a key from `sessionStorage`.   |

Register the whole catalog:

```ts
BUNDLED_TOOLS.forEach((def) => agent.registerFunction(def));
```

Or cherry-pick:

```ts
import { getCurrentTime, evaluateMath, setLocalStorageItem } from '@forgewisp/bundled-tools';

agent.registerFunction(getCurrentTime);
agent.registerFunction(evaluateMath);
agent.registerFunction(setLocalStorageItem);
```

## Planning tools

The seven plan-management tools are also exported as a ready-to-register
`ToolSet` named `PLANNING_TOOLS` (`listPlans`, `getPlan`, `createPlan`,
`addPlanItem`, `updatePlanItem`, `removePlanItem`, `deletePlan`). Register them
in one call with `agent.registerToolSet` (a method on the agent from
`@forgewisp/core`):

```ts
import { PLANNING_TOOLS } from '@forgewisp/bundled-tools';

agent.registerToolSet(PLANNING_TOOLS);
```

These seven tools are members of `BUNDLED_TOOLS`, so registering the whole
catalog (the Quick start above) registers them too — `PLANNING_TOOLS` is for
consumers who want just the planning scratchpad. `apps/planning-demo` exercises
them end-to-end.

## Risk tiers

`@forgewisp/bundled-tools` respects the same risk-tier boundary as
`@forgewisp/core`. **Tier discipline is a security boundary here too:**

- **`read`** tools run immediately, no confirmation.
- **`write` / `destructive`** tools require the consumer to configure
  `onConfirmRequired`. `@forgewisp/core` throws **at registration time** if
  a `write`/`destructive` tool is registered without it, so registering the
  whole `BUNDLED_TOOLS` catalog (which includes `removeLocalStorageItem`) will
  throw unless `onConfirmRequired` is set.

**Confirmation UI must be rendered only from the schema-validated
`PendingCall.args`** — never from raw LLM output. The executor validates args
against the JSON Schema before confirmation, so the args you get back are
guaranteed well-formed.

## Defining your own tool

The package re-exports `defineTool`, an identity helper that infers handler
argument types from a `TArgs` shape:

```ts
import { defineTool } from '@forgewisp/bundled-tools';
import type { FunctionDefinition } from '@forgewisp/core';

export const myTool: FunctionDefinition<MyArgs> = defineTool({
  name: 'myTool',
  description: '...',
  riskTier: 'read',
  parameters: {
    type: 'object',
    properties: { /* ... */ },
    required: [],
    additionalProperties: false,
  },
  handler: (args) => {
    // `args` is typed as MyArgs — no cast needed.
    return result;
  },
});
```

The JSON Schema is hand-authored; `defineTool` does not derive it from the TS
type (that would require a runtime schema builder, which this package does not
depend on).

## Tests

```bash
pnpm install
pnpm --filter @forgewisp/bundled-tools test   # vitest run
```

Each tool has a dedicated test file under `tests/`. The safe-math evaluator
has its own `eval-math.test.ts` covering the closed grammar, precedence, and
overflow guard.

## License

MIT