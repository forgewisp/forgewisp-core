import { AuditLog } from './audit.js';
import { toErrorMessage } from './errors.js';
import { HttpClient } from './http.js';
import { runToolLoop } from './loop.js';
import { FunctionRegistry } from './registry.js';
import { streamCompletion } from './streaming.js';
import { compileSchema } from './validator.js';
import {
  AgentResult,
  AuditEvent,
  ChatMessage,
  FunctionDefinition,
  ForgewispConfig,
  ToolSet,
} from './types.js';
import type { LLMMessage } from './wire.js';

const DEFAULT_MAX_TOOL_ROUNDS = 10;
const DEFAULT_LOOP_RETRIES = 1;

/**
 * Coerces `config.loopRetries` to a non-negative integer. Falls back to the
 * default for missing / NaN / Infinity / negative values: a NaN or negative
 * value would make the retry loop's `attempt <= loopRetries` guard false on the
 * first iteration, so `callLLM` is never invoked and the run silently fails
 * with `error: undefined`; an `Infinity` would hang retrying forever on a
 * persistent transient error. `0` is honored (disables loop-level retry).
 */
function normalizeLoopRetries(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_LOOP_RETRIES;
  }
  return Math.floor(value);
}

export class ForgewispAgent {
  private config: ForgewispConfig;
  private registry: FunctionRegistry;
  private audit: AuditLog;
  private http: HttpClient;
  private maxToolRounds: number;
  private loopRetries: number;

  constructor(config: ForgewispConfig) {
    this.config = config;
    this.registry = new FunctionRegistry();
    this.maxToolRounds = config.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    this.loopRetries = normalizeLoopRetries(config.loopRetries);

    // Resolve the audit callback: prefer `audit.onEvent`, fall back to the
    // deprecated top-level `onAuditEvent` for migration compatibility.
    const auditCallback = config.audit?.onEvent ?? config.onAuditEvent ?? undefined;
    this.audit = new AuditLog(auditCallback, config.audit?.maxEvents, config.audit?.redact);

    this.http = new HttpClient({
      llmEndpoint: config.llmEndpoint,
      apiKey: config.apiKey,
      model: config.model,
      requestTimeoutMs: config.requestTimeoutMs,
      maxRetries: config.http?.maxRetries,
      retryBackoffBaseMs: config.http?.retryBackoffBaseMs,
      retryBackoffMaxMs: config.http?.retryBackoffMaxMs,
      retryableStatusCodes: config.http?.retryableStatusCodes,
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  registerFunction<TArgs = Record<string, unknown>>(def: FunctionDefinition<TArgs>): void {
    if (def.riskTier !== 'read' && !this.config.onConfirmRequired) {
      throw new Error(
        `[Forgewisp] Cannot register "${def.name}" (riskTier: ${def.riskTier}): ` +
          `onConfirmRequired is not configured. Provide one in ForgewispConfig before ` +
          `registering write or destructive tools.`,
      );
    }
    // Fail-fast at registration: compile the schema now so a malformed schema
    // (an unresolvable `$ref`, an invalid keyword value, a recursive `$ref`)
    // is rejected before it enters the registry — instead of being advertised
    // to the LLM via `toLLMTools()` every round and re-compiled per call.
    // Mirrors the risk-tier invariant above. The compiled validator is cached,
    // so the per-round `validateArgs` call hits the cache and never re-compiles.
    try {
      compileSchema(def.parameters);
    } catch (err) {
      throw new Error(
        `[Forgewisp] Cannot register "${def.name}": its JSON Schema could not be ` +
          `compiled (a malformed schema is a programming bug — e.g. an unresolvable ` +
          `'$ref' or an invalid keyword value). ${toErrorMessage(err)}`,
      );
    }
    this.registry.register(def as FunctionDefinition);
  }

  /**
   * Register every tool in a ToolSet in one call. Delegates to `registerFunction`, so the
   * write/destructive tier invariant (onConfirmRequired must be configured) is enforced
   * per-tool, in input order — the first write/destructive tool without a handler throws.
   */
  registerToolSet(set: ToolSet): void {
    for (const def of set.tools) this.registerFunction(def);
  }

  deregisterFunction(name: string): void {
    this.registry.deregister(name);
  }

  async run(
    userMessage: string,
    options?: { history?: ChatMessage[]; signal?: AbortSignal },
  ): Promise<AgentResult> {
    return runToolLoop(
      {
        callLLM: (messages, sig) => this.callLLM(messages, sig),
        registry: this.registry,
        audit: this.audit,
        config: this.config,
        maxToolRounds: this.maxToolRounds,
        loopRetries: this.loopRetries,
      },
      userMessage,
      options?.signal,
      options?.history,
    );
  }

  getAuditLog(): AuditEvent[] {
    return this.audit.getAll();
  }

  exportAuditLog(): string {
    return this.audit.exportJSON();
  }

  clearAuditLog(): void {
    this.audit.clear();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async callLLM(
    messages: LLMMessage[],
    signal?: AbortSignal,
  ): Promise<{ message: LLMMessage; reasoning: string; reasoningTokens?: number }> {
    const tools = this.registry.toLLMTools();
    const streamingConfig = this.config.streaming;

    // Pass the external (user/run) signal to `post`; it applies the per-attempt
    // timeout internally and refreshes it each retry. The returned `signal` is
    // the one bound to the successful fetch — reuse it for streaming so the
    // same per-attempt timeout keeps covering body consumption.
    const { response, signal: responseSignal } = await this.http.post(
      messages,
      tools,
      streamingConfig !== undefined,
      signal,
    );

    if (streamingConfig) {
      const result = await streamCompletion(response, streamingConfig, this.audit, responseSignal);
      return {
        message: result.message,
        reasoning: result.reasoning,
        ...(result.reasoningTokens !== undefined
          ? { reasoningTokens: result.reasoningTokens }
          : {}),
      };
    }

    // Non-streaming path. The fetch signal (responseSignal) still covers
    // response.json() — a timeout / abort during body consumption rejects here.
    const data = (await response.json()) as {
      choices?: Array<{ message: LLMMessage }>;
    };

    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('[Forgewisp] LLM returned no choices.');
    return { message, reasoning: '' };
  }
}
