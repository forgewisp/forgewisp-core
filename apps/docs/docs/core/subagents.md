---
sidebar_position: 7
---

# Subagents

`createSubagentTool(config)` builds a tool that, when called by the model, spins up a **fresh
subagent** to handle a delegated sub-task and returns its result. It's declarative — no
consumer-written spawn closure — and lives in core because it needs `createAgent` at runtime (a
same-package call).

## Why

A single flat agent with 30 tools gets confused; a router that delegates to focused subagents with
narrow toolsets does better. `createSubagentTool` lets you expose that delegation as just another
tool the parent agent can call.

```ts
import { createAgent, createSubagentTool } from '@forgewisp/core';

const config = {
  model: 'gpt-4o-mini',
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiKey: import.meta.env.VITE_OPENAI_API_KEY,
  onConfirmRequired: async () => true,
};

const researchTool = createSubagentTool({
  config, // the parent agent's ForgewispConfig — the subagent reuses it
  tools: [/* a focused pool of FunctionDefinitions */],
  // systemPrompt?, maxToolRounds? optional
});

const agent = createAgent(config);
agent.registerFunction(researchTool);
```

## Risk tiers

The `spawnSubagent` tool is **always `read`-tier** — it's hardcoded by the factory, not
configurable. This is a deliberate, narrow exception: spawning is the agent's own control flow for
decomposing a task, and gating it on `onConfirmRequired` would block the orchestration loop. It is
not a precedent for demoting other tools. The subagent's **own** tools still carry their own tiers
and confirmation semantics — a subagent calling a `destructive` tool still triggers
`onConfirmRequired` (reused from the parent config).

## Recursion guard

A subagent is a fresh agent with its own toolset. To prevent unbounded self-delegation, the factory
filters any tool named `"spawnSubagent"` out of the pool, so the subagent is never granted the spawn
tool. The guard lives in the factory, not in a consumer contract — there is no depth to configure;
recursion is simply impossible because the spawn tool is stripped before the subagent ever runs.

## Abort forwarding

The parent run's `AbortSignal` (threaded in via `ToolContext`) is forwarded to the subagent's own
`run`, merged with the subagent's per-request timeout. Aborting the parent run aborts the
subagent's in-flight HTTP and any tools it is currently executing.

## When to reach for it

- You have distinct phases (research → plan → execute) that benefit from separate toolsets.
- You want to limit the parent's context by offloading detail-heavy sub-tasks.
- You're building a router pattern.

See the API reference for `SubagentToolConfig`, `SpawnSubagentArgs`, and
`SpawnSubagentResult`.