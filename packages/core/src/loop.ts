import { AuditLog } from './audit.js';
import { executeToolCalls } from './executor.js';
import { toErrorMessage } from './errors.js';
import {
  backoffDelay,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
  isHttpError,
  sleep,
} from './http.js';
import { FunctionRegistry } from './registry.js';
import { AgentReasoning, AgentResult, ChatMessage, ForgewispConfig } from './types.js';
import type { LLMMessage } from './wire.js';

export interface ToolLoopDeps {
  callLLM: (
    messages: LLMMessage[],
    signal?: AbortSignal,
  ) => Promise<{
    message: LLMMessage;
    reasoning: string;
    reasoningTokens?: number;
  }>;
  registry: FunctionRegistry;
  audit: AuditLog;
  config: ForgewispConfig;
  maxToolRounds: number;
  /**
   * Max loop-level retry attempts after the first call to the LLM fails with a
   * retryable error. Defaults to 1 at the agent layer; tests override via deps.
   */
  loopRetries: number;
}

/**
 * Drives the chat → tool-call → chat loop until the model returns a final
 * response or the max-rounds cap is hit. Pure orchestration: HTTP and tool
 * execution are injected via `deps`.
 */
export async function runToolLoop(
  deps: ToolLoopDeps,
  userMessage: string,
  signal?: AbortSignal,
  history?: ChatMessage[],
): Promise<AgentResult> {
  const messages: LLMMessage[] = [];

  if (deps.config.systemPrompt) {
    messages.push({ role: 'system', content: deps.config.systemPrompt });
  }
  // Prior chat turns sit between the system prompt and the new user message.
  if (history) {
    for (const m of history) {
      messages.push({ role: m.role, content: m.content });
    }
  }
  messages.push({ role: 'user', content: userMessage });

  const allExecuted: AgentResult['toolCallsExecuted'] = [];
  const allAborted: AgentResult['toolCallsAborted'] = [];
  let accumulatedReasoning = '';
  let accumulatedReasoningTokens: number | undefined;

  const reasoningMode = deps.config.streaming?.reasoning?.mode ?? 'none';

  for (let round = 0; round < deps.maxToolRounds; round++) {
    // Drive the LLM call for this round, retrying transient failures within the
    // loop-level budget. The HTTP layer already retries 429/503/504/network
    // resets up to its own `maxRetries`; a retryable `HttpError` reaching here
    // means THAT attempt's HTTP budget is exhausted, so the loop layer starts a
    // fresh callLLM — which itself begins a fresh HTTP retry sequence. The two
    // budgets are multiplicative: at most (http.maxRetries+1) × (loopRetries+1)
    // fetches per round for a persistent retryable failure (defaults 4×2 = 8;
    // loopRetries: 3 → 4×4 = 16). Tune deliberately — this amplifies load on an
    // already-failing upstream. A user/run abort is never a failure — it
    // rethrows so `agent.run` rejects with the abort reason. A terminal error
    // records a `run_failed` audit event and returns the partial state
    // accumulated so far instead of throwing bare.
    let llmResult: { message: LLMMessage; reasoning: string; reasoningTokens?: number } | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt <= deps.loopRetries; attempt++) {
      try {
        llmResult = await deps.callLLM(messages, signal);
        break;
      } catch (err) {
        // A user/run abort propagates immediately — never retried, never audited
        // as a failure. `signal?.aborted` distinguishes an intentional cancel
        // (or external timeout) from a per-attempt timeout the HTTP layer
        // surfaces as an abort-like error.
        if (signal?.aborted) throw err;
        lastError = err;
        const retryable = isHttpError(err) && err.isRetryable;
        if (retryable && attempt < deps.loopRetries) {
          // Sleep on the run signal: if the user aborts during backoff, the
          // sleep rejects and the abort propagates (not audited as run_failed).
          await loopBackoffSleep(attempt + 1, deps.config, signal);
          continue;
        }
        break;
      }
    }

    if (!llmResult) {
      const errMsg = toErrorMessage(lastError);
      // Preserve the original stack on the audit event so a programming error
      // (e.g. a TypeError regression in streaming) laundered through this
      // catch-all is still debuggable from the audit export — the user-facing
      // `error` string carries only the message.
      const errorStack = lastError instanceof Error ? lastError.stack : undefined;
      deps.audit.record('run_failed', 'system', {
        error: errMsg,
        ...(errorStack ? { errorStack } : {}),
      });
      return {
        response: '',
        reasoning: buildReasoning(reasoningMode, accumulatedReasoning, accumulatedReasoningTokens),
        truncated: false,
        failed: true,
        error: errMsg,
        toolCallsExecuted: allExecuted,
        toolCallsAborted: allAborted,
      };
    }

    const { message, reasoning, reasoningTokens } = llmResult;
    messages.push(message);

    if (reasoning) accumulatedReasoning += reasoning;
    if (reasoningTokens !== undefined) {
      accumulatedReasoningTokens = (accumulatedReasoningTokens ?? 0) + reasoningTokens;
    }

    // No tool calls → final response
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return {
        response: message.content ?? '',
        reasoning: buildReasoning(reasoningMode, accumulatedReasoning, accumulatedReasoningTokens),
        truncated: false,
        toolCallsExecuted: allExecuted,
        toolCallsAborted: allAborted,
      };
    }

    const { toolResults, executed, aborted } = await executeToolCalls(
      message.tool_calls,
      deps.registry,
      deps.audit,
      deps.config,
      signal,
    );

    allExecuted.push(...executed);
    allAborted.push(...aborted);

    for (const result of toolResults) {
      let content: string;
      try {
        if (result.success) {
          const def = deps.registry.get(result.functionName);
          content = serializeToolResult(result.result, def?.compactResultForLLM ?? true);
        } else if (result.abortReason === 'confirmation_rejected') {
          // The user explicitly declined this tool call in the confirmation
          // dialog. This is a final user decision, not a transient failure —
          // tell the model plainly so it doesn't retry or treat it as an error.
          content =
            'The user declined to run this tool (cancelled the confirmation ' +
            'dialog). Do not retry or attempt this action again. Respond to the ' +
            'user: acknowledge the cancellation, offer an alternative if ' +
            'appropriate, or continue without it.';
        } else {
          content = JSON.stringify({ error: result.error ?? result.abortReason });
        }
      } catch (err) {
        // Handler returned a non-serializable value (e.g. circular). Don't let
        // it kill the run — fall back to a placeholder and audit the failure.
        const errMsg = toErrorMessage(err);
        content = JSON.stringify({ error: '[non-serializable result]' });
        deps.audit.record('function_errored', result.functionName, {
          error: `result serialization failed: ${errMsg}`,
        });
      }
      messages.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content,
      });
    }

    // A user/run abort during tool execution (e.g. Stop clicked while a
    // confirmation dialog was open) must propagate as a rejection, not fall
    // through to the max-rounds `truncated` return — otherwise the caller can't
    // distinguish an intentional stop from a genuine cap hit. Without this,
    // aborting during the final round's tool calls resolves `{ truncated: true }`
    // instead of rejecting, so the caller's abort branch never runs. On earlier
    // rounds this throws one iteration sooner than the next `callLLM` would
    // (which also rethrows on `signal?.aborted`), so the observable result is
    // unchanged for them. Like every other abort path, this is never audited as
    // `run_failed`.
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('[Forgewisp] Aborted.');
    }
  }

  deps.audit.record('max_tool_rounds_reached', 'system', {
    error: `Exceeded ${deps.maxToolRounds} tool-call rounds without a final response.`,
  });

  return {
    response: '',
    reasoning: buildReasoning(reasoningMode, accumulatedReasoning, accumulatedReasoningTokens),
    truncated: true,
    toolCallsExecuted: allExecuted,
    toolCallsAborted: allAborted,
  };
}

function buildReasoning(
  mode: 'none' | 'extended' | 'tag-based' | 'native',
  text: string,
  tokens: number | undefined,
): AgentReasoning | undefined {
  if (mode === 'none' || !text) return undefined;
  return {
    mode,
    text,
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

// ─── Loop-level retry helpers ────────────────────────────────────────────────
//
// The loop layer adds a small retry budget on top of the HTTP layer's own. It
// reuses the HTTP-layer backoff knobs (`http.retryBackoffBaseMs` /
// `retryBackoffMaxMs`) AND the HTTP layer's `sleep` / `backoffDelay` helpers —
// one backoff curve, configured and implemented in one place (http.ts), so the
// two layers cannot drift apart.

/**
 * Sleeps for a loop-level backoff before retrying the LLM call, using the
 * HTTP-layer backoff config and helpers. Aborts during backoff propagate as
 * rejections (the caller rethrows on `signal?.aborted`).
 */
function loopBackoffSleep(
  attempt: number,
  config: ForgewispConfig,
  signal?: AbortSignal,
): Promise<void> {
  const base = config.http?.retryBackoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const max = config.http?.retryBackoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
  return sleep(backoffDelay(attempt, base, max), signal);
}

// ─── Tool-result serialization for the LLM ───────────────────────────────────
//
// Tool results are sent back to the model as the `content` of a `tool` role
// message, then carried in every subsequent request body. A tool that returns a
// large blob — a base64 PNG data URL, a big localStorage value, a long list of
// keys — bloats the request and can cause the LLM stream to abort
// ("BodyStreamBuffer was aborted") or waste context on bytes the model cannot
// use. The full result is already in the audit log (the executor records it
// before this runs), so we send the model a compact form: short fields pass
// through unchanged; long strings and oversized arrays are elided.
//
// The elision marker is worded to communicate SUCCESS, not incompleteness. A
// marker like "[truncated: N chars]" reads to an LLM as "the output got cut
// off," which can prompt it to call the tool again to recover the "missing"
// data (e.g. regenerating a QR code → duplicate artifacts). So the marker states
// the tool succeeded and the payload was only omitted for size, and notes the
// full value lives in the audit log. The marker is intentionally neutral about
// retry: whether re-calling makes sense is tool-specific and belongs in each
// tool's own description, not baked into core's elision protocol.
//
// A tool may opt out of compaction by setting `compactResultForLLM: false` on
// its `FunctionDefinition` (e.g. a document fetcher whose full text the model
// must read to answer). Opted-out results are sent verbatim — the tool author
// accepts the larger request in exchange for the model seeing the full content.

const MAX_TOOL_RESULT_CHARS = 4000;
const MAX_STRING_CHARS = 200;
const MAX_ARRAY_ELEMENTS = 20;

const OMITTED_NOTE =
  'tool succeeded, payload too large to relay; full value retained in the audit log';

function omitString(len: number): string {
  return `[omitted: ${len}-char payload — ${OMITTED_NOTE}]`;
}

/**
 * Serializes a tool result for the LLM-bound `tool` message. When `compact` is
 * true (the default) and the JSON form exceeds `MAX_TOOL_RESULT_CHARS`, the
 * value is compacted (long strings / oversized arrays elided); if the compact
 * form STILL exceeds the cap — e.g. a wide flat object of many short fields,
 * none of which individually elide — the whole payload is replaced with a single
 * omission marker, guaranteeing a bounded message. When `compact` is false the
 * value is sent verbatim. Throws on non-serializable values (circular refs,
 * BigInts); the caller handles that by recording an audit event and falling back
 * to a placeholder.
 */
function serializeToolResult(value: unknown, compact: boolean): string {
  const json = JSON.stringify(value) ?? '';
  if (!compact || json.length <= MAX_TOOL_RESULT_CHARS) return json;
  const compacted = compactForLLM(value);
  const compactJson = JSON.stringify(compacted) ?? '';
  if (compactJson.length <= MAX_TOOL_RESULT_CHARS) return compactJson;
  // The compact form is still over the cap (wide flat object with many short
  // fields). Replace the whole payload with one bounded marker — the full
  // value is in the audit log.
  return JSON.stringify(omitString(json.length));
}

/**
 * Returns a compacted copy of `value` for LLM consumption. One traversal
 * (`compact`) is the single source of truth; this is the thin wrapper that
 * drops the `didTruncate` flag the caller here doesn't need. Strings longer
 * than `MAX_STRING_CHARS` become an `[omitted: …]` marker; arrays longer than
 * `MAX_ARRAY_ELEMENTS` become a `{ length, sample, __omitted }` summary; a
 * plain object with any elided field is tagged `__omitted: true` so the model
 * can tell large content was dropped (not that the call failed). Builds fresh
 * plain objects/arrays (the original already serialized, so no circular refs
 * reach here).
 */
function compactForLLM(value: unknown): unknown {
  return compact(value)[0];
}

/** Returns `[compactedValue, didTruncate]`. The single recursive compactor. */
function compact(value: unknown): [unknown, boolean] {
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS ? [omitString(value.length), true] : [value, false];
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ELEMENTS) {
      return [
        {
          length: value.length,
          sample: value.slice(0, 3).map((v) => compact(v)[0]),
          __omitted: true,
        },
        true,
      ];
    }
    let any = false;
    const mapped = value.map((v) => {
      const [c, t] = compact(v);
      if (t) any = true;
      return c;
    });
    return [mapped, any];
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let any = false;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const [c, t] = compact(v);
      if (t) any = true;
      out[k] = c;
    }
    return [any ? { ...out, __omitted: true } : out, any];
  }
  return [value, false];
}
