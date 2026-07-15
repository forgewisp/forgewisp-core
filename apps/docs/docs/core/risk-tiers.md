---
sidebar_position: 6
---

# Risk tiers

Every `FunctionDefinition` declares a `riskTier`: `read`, `write`, or `destructive`. This is a
**security boundary**, not a UX hint. It controls whether the executor calls `onConfirmRequired`
before running the handler.

| Tier | Confirmation | Typical use |
| --- | --- | --- |
| `read` | None — runs immediately. | Reading state: `listTasks`, `getCurrentTime`, `getViewportInfo`. |
| `write` | Yes — `onConfirmRequired` must approve. | Side effects: `addTask`, `copyToClipboard`, `downloadFile`. |
| `destructive` | Yes — `onConfirmRequired` must approve. | Irreversible effects: `deleteTask`, `removeLocalStorageItem`. |

## The registration-time invariant

Registering a `write` or `destructive` tool **throws at registration time** if `onConfirmRequired`
is not configured:

```ts
const agent = createAgent({ model: 'x', llmEndpoint: 'x' });
// no onConfirmRequired configured

agent.registerFunction({
  name: 'deleteTask',
  riskTier: 'destructive',
  // ...
  handler: async () => { /* ... */ },
});
// ❌ throws: cannot register a write/destructive tool without onConfirmRequired
```

This is deliberate. A dangerous tool that silently lacks confirmation is a footgun; failing at
build/registration time — before the first dangerous call — is the safe default.

## Confirmation UI is rendered from validated args

The `PendingCall` passed to `onConfirmRequired` carries `args` that are **always schema-validated,
never raw LLM output**:

```ts
onConfirmRequired: async (call) => {
  // call.functionName, call.args (validated), call.riskTier
  return await showConfirmDialog({
    tool: call.functionName,
    tier: call.riskTier,
    args: call.args, // safe to render — it passed your JSON Schema
  });
},
```

This matters because the model can return arbitrary text in its raw `arguments`. Without validation
first, a malicious or confused model could push untrusted strings into your confirm dialog. Core
parses + `validateArgs` **before** constructing the `PendingCall`, so what you render is shaped by
your schema (`additionalProperties: false`, bounded lengths, enums for closed sets, …).

:::warning
Never render confirmation UI from the raw `tool_call.arguments` string. Always use the
schema-validated `PendingCall.args`.
:::

## How the executor enforces it

`executeToolCalls` runs a synchronous pre-pass (lookup → JSON.parse → `validateArgs`) that emits
`function_requested` / `validation_*` audit events in input order. Only validated calls proceed to
the confirmation + handler phase, which runs **concurrently** via `Promise.allSettled`. `read`-tier
tools skip confirmation entirely; `write`/`destructive` block on `onConfirmRequired` first. A
rejected confirmation is recorded and the call is not executed.

See the API reference for `RiskTier`, `PendingCall`, and `FunctionDefinition`.