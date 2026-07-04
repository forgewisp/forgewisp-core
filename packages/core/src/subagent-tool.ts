/**
 * Subagent spawn tool — a declarative factory that builds a `spawnSubagent`
 * `FunctionDefinition` from a config object (no hand-written spawn closure).
 *
 * Unlike the read/write/destructive tools a consumer registers directly, a subagent tool
 * has to build and run a *fresh* agent per call. That needs `createAgent` at runtime —
 * which is why this factory lives in `@forgewisp/core` (core owns `createAgent`; importing
 * it here is a same-package call, not a cross-package runtime dep). A consumer declares
 * the subagent's LLM config, its tool pool, and optional defaults; the factory handles
 * tool resolution, subagent config, execution, and result trimming.
 *
 *   import { createAgent, createSubagentTool } from '@forgewisp/core';
 *   agent.registerFunction(createSubagentTool({ config, tools: SAFE_READ_TOOLS }));
 *
 * ── Execution model ──────────────────────────────────────────────────────────
 * Sync spawn-and-wait: the handler runs the subagent's full tool loop to completion and
 * returns a TRIMMED result. The subagent's intermediate reasoning and tool calls live only
 * in its own transient context; only the trimmed `SpawnSubagentResult` is JSON.stringified
 * back into the parent's tool message. That trimming is the whole point — the parent's
 * context stays small even when the subagent made many tool calls with large intermediate
 * inputs.
 *
 * ── Risk-tier rationale ─────────────────────────────────────────────────────
 * `spawnSubagent` is `read`-tier. This is a deliberate, narrow exception: spawning is the
 * agent's OWN control flow for decomposing a task, and gating it on `onConfirmRequired`
 * would block the orchestration loop. It is justified because the args are bounded and
 * schema-validated and the orchestration is agent-owned. It is an exception, not a
 * precedent for demoting other tools.
 *
 * The subagent itself may register `write`/`destructive` tools from the pool; those calls
 * are still gated by the SUBAGENT's own `onConfirmRequired` (reused from the parent config
 * the consumer passes in). So the read-tier exception here does NOT bypass confirmation
 * for the subagent's real side effects.
 *
 * ── Recursion guard ──────────────────────────────────────────────────────────
 * The factory filters any tool named `"spawnSubagent"` out of the pool, so the subagent
 * can never be granted the spawn tool (no unbounded recursion). The guard lives in the
 * factory, not in a consumer contract.
 *
 * ── Abort signal ─────────────────────────────────────────────────────────────
 * The parent run's `AbortSignal` is threaded into tool handlers by the core executor (see
 * `ToolContext`), so the factory reads `context.signal` and passes it to `subagent.run`.
 * Aborting the parent run aborts the in-flight subagent. No consumer closure needed.
 *
 * ── Why the tool description lists the pool's tool names ─────────────────────
 * The parent LLM decides which tools to name in `args.tools`. If the description only
 * describes capabilities in prose, the LLM guesses names that don't match the actual
 * registered functions → the subagent is granted nothing. The factory therefore injects
 * the pool's exact tool names into the `spawnSubagent` description, keeping it in sync
 * with the pool automatically. As a defense, if `args.tools` names nothing that matches,
 * the handler falls back to the whole pool rather than registering zero tools.
 */

import { ForgewispAgent } from './agent.js';
import type {
  AgentResult,
  ForgewispConfig,
  FunctionDefinition,
  JSONSchema,
  ToolContext,
  ToolSet,
} from './types.js';

// ─── Args & result ────────────────────────────────────────────────────────────

export interface SpawnSubagentArgs {
  /** A self-contained task for the subagent. The subagent sees NO parent conversation. */
  task: string;
  /**
   * Names of the pool tools the subagent may use. Omit for the whole pool. MUST NOT include
   * "spawnSubagent" (filtered out by the factory as a recursion guard). If a name matches
   * nothing in the pool, the factory falls back to the whole pool rather than registering
   * zero tools.
   */
  tools?: string[];
  /** Optional override of the subagent's system prompt (replaces the factory default). */
  systemPrompt?: string;
  /** Optional cap on the subagent's tool-call rounds. */
  maxToolRounds?: number;
}

/**
 * Trimmed projection returned to the PARENT's tool message. Deliberately drops `reasoning`
 * and the full `toolCallsExecuted` / `toolCallsAborted` arrays (which carry every sub-call's
 * args + results) so the parent's context does not absorb the subagent's intermediate work.
 */
export interface SpawnSubagentResult {
  /** The subagent's final response text. */
  response: string;
  /** True when the subagent hit its max-rounds cap without a final response. */
  truncated: boolean;
  /** How many tool calls the subagent executed. */
  toolCallsExecuted: number;
  /** How many sub-tool calls were aborted (rejected/errored). */
  toolCallsAborted: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface SubagentToolConfig {
  /**
   * The PARENT agent's config. The subagent reuses its `llmEndpoint`/`apiKey`/`model`/
   * `requestTimeoutMs`, its `onConfirmRequired` (so the subagent's write/destructive calls
   * prompt through the same UI), its `onAuditEvent`/`audit` sink, and its
   * `streaming.reasoning` mode — but NOT its `systemPrompt` (the subagent is a focused
   * worker, not an orchestrator) and NOT its streaming `onTextChunk`/`onReasoningChunk`
   * callbacks (those would pollute the parent's chat/reasoning UI with the subagent's
   * intermediate output).
   */
  config: ForgewispConfig;
  /**
   * The tools the subagent may use (the pool). The LLM's `args.tools` selects a subset by
   * name; omit `args.tools` to grant the whole pool. Any tool named `"spawnSubagent"` is
   * filtered out (recursion guard). Accepts a `ToolSet` or a plain array.
   */
  tools: ToolSet | readonly FunctionDefinition<never>[];
  /** Default subagent system prompt. The subagent does NOT inherit the parent's. */
  systemPrompt?: string;
  /** Default cap on the subagent's tool-call rounds. */
  maxToolRounds?: number;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description:
        'A self-contained task for the subagent. Must include ALL context the subagent needs — ' +
        'the subagent does NOT see this conversation. 1–4000 chars.',
      minLength: 1,
      maxLength: 4000,
    },
    tools: {
      type: 'array',
      description:
        'Names of the pool tools the subagent may use. Omit for the whole pool. MUST NOT ' +
        'include "spawnSubagent". Max 20 entries.',
      maxItems: 20,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
      },
    },
    systemPrompt: {
      type: 'string',
      description: 'Optional override of the subagent system prompt. 1–2000 chars.',
      minLength: 1,
      maxLength: 2000,
    },
    maxToolRounds: {
      type: 'integer',
      description: 'Optional cap on the subagent tool-call rounds. 1–40.',
      minimum: 1,
      maximum: 40,
    },
  },
  required: ['task'],
  additionalProperties: false,
};

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Normalize the pool to an array and strip any `spawnSubagent` (recursion guard). */
function normalizePool(
  tools: ToolSet | readonly FunctionDefinition<never>[],
): FunctionDefinition<never>[] {
  const arr: readonly FunctionDefinition<never>[] = 'tools' in tools ? tools.tools : tools;
  return arr.filter((t) => t.name !== 'spawnSubagent');
}

/**
 * Resolve the granted tools from the LLM-supplied `args.tools`. If `args.tools` is omitted
 * (or empty) → the whole pool. If supplied but nothing matches → fall back to the whole
 * pool (defense: the LLM guessed wrong names; registering zero tools is never useful).
 */
function resolveGranted(
  argsTools: string[] | undefined,
  pool: readonly FunctionDefinition<never>[],
): FunctionDefinition<never>[] {
  if (!argsTools || argsTools.length === 0) return [...pool];
  const requested = new Set(argsTools);
  const matched = pool.filter((t) => requested.has(t.name));
  return matched.length > 0 ? matched : [...pool];
}

/**
 * Build the subagent config from the parent's, reusing the connection + confirm + audit +
 * reasoning-mode, but NOT the parent's system prompt or streaming UI callbacks.
 */
function buildSubConfig(cfg: SubagentToolConfig, args: SpawnSubagentArgs): ForgewispConfig {
  const parent = cfg.config;
  return {
    llmEndpoint: parent.llmEndpoint,
    apiKey: parent.apiKey,
    model: parent.model,
    requestTimeoutMs: parent.requestTimeoutMs,
    // Inherit the parent's HTTP retry/backoff config so spawned subagents honor
    // the same retry budget rather than falling back to defaults.
    http: parent.http,
    // The subagent is a focused worker, NOT an orchestrator — never inherit the parent's
    // system prompt. Per-call override beats the factory default.
    systemPrompt: args.systemPrompt ?? cfg.systemPrompt,
    maxToolRounds: args.maxToolRounds ?? cfg.maxToolRounds,
    // Reuse the parent's confirm handler so the subagent's write/destructive calls prompt.
    onConfirmRequired: parent.onConfirmRequired,
    onAuditEvent: parent.onAuditEvent,
    audit: parent.audit,
    // Stream internally (so reasoning still works) but with NO UI callbacks — the
    // subagent's intermediate text/reasoning must not pollute the parent's UI. Only the
    // trimmed final result reaches the parent.
    streaming: parent.streaming?.reasoning ? { reasoning: parent.streaming.reasoning } : undefined,
  };
}

/** Trim a full `AgentResult` to the projection the parent's tool message carries. */
function trimResult(result: AgentResult): SpawnSubagentResult {
  return {
    response: result.response,
    truncated: result.truncated,
    toolCallsExecuted: result.toolCallsExecuted.length,
    toolCallsAborted: result.toolCallsAborted.length,
  };
}

/**
 * Build a `spawnSubagent` tool from a declarative config. The returned `FunctionDefinition`
 * is ready to register with `agent.registerFunction`. The factory builds + runs the
 * subagent internally, so the consumer never writes a spawn closure.
 */
export function createSubagentTool(cfg: SubagentToolConfig): FunctionDefinition<SpawnSubagentArgs> {
  const pool = normalizePool(cfg.tools);
  const toolList = pool.map((t) => t.name).join(', ');

  const description =
    'Spawn a subagent for a self-contained heavy sub-task (multi-step research, ' +
    'large-context summarization, batch processing) that would bloat this conversation if ' +
    'done inline. The subagent runs its own tool loop to completion and returns ONLY its ' +
    'final answer; its intermediate reasoning and tool calls stay in its own context and ' +
    'do NOT pollute this one. Use this when a sub-task needs 3+ tool calls or a large ' +
    'intermediate context; for a single quick tool call, call the tool directly instead of ' +
    'spawning. The subagent does NOT see this conversation — pass all needed context in ' +
    '`task`. ' +
    (toolList
      ? `The subagent may use these tools: ${toolList}. Pass their exact names in \`tools\`, ` +
        'or omit `tools` to grant all of them. '
      : '') +
    'Never include "spawnSubagent" in `tools` (subagents cannot spawn subagents).';

  return {
    name: 'spawnSubagent',
    description,
    // read-tier: agent-orchestration exception — see this file's header.
    riskTier: 'read',
    parameters,
    handler: async (
      args: SpawnSubagentArgs,
      context?: ToolContext,
    ): Promise<SpawnSubagentResult> => {
      const granted = resolveGranted(args.tools, pool);
      const subConfig = buildSubConfig(cfg, args);

      const sub = new ForgewispAgent(subConfig);
      sub.registerToolSet({ name: 'subagent-tools', tools: granted });
      const result = await sub.run(args.task, { signal: context?.signal });
      return trimResult(result);
    },
  };
}
