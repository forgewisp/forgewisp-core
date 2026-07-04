import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runToolLoop, ToolLoopDeps } from '../src/loop.js';
import { FunctionRegistry } from '../src/registry.js';
import { AuditLog } from '../src/audit.js';
import { HttpError } from '../src/http.js';
import { ForgewispConfig } from '../src/types.js';
import type { LLMMessage } from '../src/wire.js';

const baseConfig: ForgewispConfig = {
  llmEndpoint: 'https://api.example.com/v1/chat/completions',
  model: 'gpt-4o',
};

// A tool-call round followed by a final text round. The tool message handed
// back to the model in round 1 is captured in `seenMessages`.
function makeDeps(
  registry: FunctionRegistry,
  audit: AuditLog,
  config: ForgewispConfig,
  seenMessages: Parameters<ToolLoopDeps['callLLM']>[0][],
): ToolLoopDeps {
  let round = 0;
  const callLLM: ToolLoopDeps['callLLM'] = (messages) => {
    seenMessages.push(messages);
    if (round === 0) {
      round += 1;
      return Promise.resolve({
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'writeData', arguments: JSON.stringify({ value: 'x' }) },
            },
          ],
        },
        reasoning: '',
      });
    }
    return Promise.resolve({
      message: { role: 'assistant', content: 'ok, I will not retry' },
      reasoning: '',
    });
  };
  return { callLLM, registry, audit, config, maxToolRounds: 5, loopRetries: 1 };
}

describe('runToolLoop — confirmation cancellation', () => {
  let registry: FunctionRegistry;
  let audit: AuditLog;

  beforeEach(() => {
    registry = new FunctionRegistry();
    audit = new AuditLog();
    registry.register({
      name: 'writeData',
      description: 'Write',
      riskTier: 'write',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      handler: vi.fn(),
    });
  });

  it('tells the LLM the user declined and not to retry (not a generic error)', async () => {
    const seenMessages: Parameters<ToolLoopDeps['callLLM']>[0][] = [];
    const deps = makeDeps(
      registry,
      audit,
      { ...baseConfig, onConfirmRequired: vi.fn().mockResolvedValue(false) },
      seenMessages,
    );

    const result = await runToolLoop(deps, 'please write x');

    // Round 1 receives the tool result message produced from the cancel.
    const round1 = seenMessages[1]!;
    const toolMessage = round1.find(
      (m) => m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'call_1',
    );

    expect(toolMessage).toBeDefined();
    const content = (toolMessage as { content: string }).content;
    // Plain, directive text — not the old {"error":"confirmation_rejected"} shape.
    expect(content).not.toBe(JSON.stringify({ error: 'confirmation_rejected' }));
    expect(content.toLowerCase()).toContain('declined');
    expect(content.toLowerCase()).toContain('do not retry');

    // Loop still terminated normally with the model's final response.
    expect(result.truncated).toBe(false);
    expect(result.response).toBe('ok, I will not retry');
    expect(result.toolCallsAborted[0]?.reason).toBe('confirmation_rejected');
  });
});

// ─── Expanded coverage via the ToolLoopDeps seam ──────────────────────────────

interface SeqResponse {
  message: LLMMessage;
  reasoning?: string;
  reasoningTokens?: number;
}

/** Builds deps whose `callLLM` plays back `responses` in order (last one repeats). */
function seqDeps(
  registry: FunctionRegistry,
  audit: AuditLog,
  config: ForgewispConfig,
  responses: SeqResponse[],
  seenMessages: LLMMessage[][],
  maxToolRounds = 5,
): ToolLoopDeps {
  let round = 0;
  const callLLM: ToolLoopDeps['callLLM'] = (messages) => {
    // Snapshot the array as it is at call time — the loop mutates it in place
    // after the call returns, so a raw reference would keep growing.
    seenMessages.push([...messages]);
    const r = responses[Math.min(round, responses.length - 1)]!;
    round += 1;
    return Promise.resolve({
      message: r.message,
      reasoning: r.reasoning ?? '',
      ...(r.reasoningTokens !== undefined ? { reasoningTokens: r.reasoningTokens } : {}),
    });
  };
  return { callLLM, registry, audit, config, maxToolRounds, loopRetries: 1 };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): LLMMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

function finalMsg(text: string | null): LLMMessage {
  return { role: 'assistant', content: text };
}

describe('runToolLoop — multi-round orchestration', () => {
  let registry: FunctionRegistry;
  let audit: AuditLog;

  beforeEach(() => {
    registry = new FunctionRegistry();
    audit = new AuditLog();
    registry.register({
      name: 'echo',
      description: 'Echo',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => 'pong',
    });
  });

  it('accumulates reasoning text across rounds (no separator)', async () => {
    const seen: LLMMessage[][] = [];
    const deps = seqDeps(
      registry,
      audit,
      { ...baseConfig, streaming: { reasoning: { mode: 'tag-based', tag: 'thinking' } } },
      [
        { message: toolCall('c1', 'echo', {}), reasoning: 'r0' },
        { message: finalMsg('done'), reasoning: 'r1' },
      ],
      seen,
    );

    const result = await runToolLoop(deps, 'hi');

    expect(result.truncated).toBe(false);
    expect(result.reasoning).toBeDefined();
    expect(result.reasoning!.mode).toBe('tag-based');
    expect(result.reasoning!.text).toBe('r0r1');
  });

  it('accumulates reasoning tokens across rounds', async () => {
    const deps = seqDeps(
      registry,
      audit,
      { ...baseConfig, streaming: { reasoning: { mode: 'extended' } } },
      [
        { message: toolCall('c1', 'echo', {}), reasoning: 'r0', reasoningTokens: 5 },
        { message: finalMsg('done'), reasoning: '', reasoningTokens: 5 },
      ],
      [],
    );

    const result = await runToolLoop(deps, 'hi');

    expect(result.reasoning).toBeDefined();
    expect(result.reasoning!.tokens).toBe(10);
  });

  it('feeds a JSON error object back to the LLM for a validation_failed tool call', async () => {
    const seen: LLMMessage[][] = [];
    const deps = seqDeps(
      registry,
      audit,
      baseConfig,
      [{ message: toolCall('c1', 'nonexistent', {}) }, { message: finalMsg('ok') }],
      seen,
    );

    const result = await runToolLoop(deps, 'hi');

    expect(result.truncated).toBe(false);
    expect(result.toolCallsAborted[0]?.reason).toBe('validation_failed');

    // Round 1 sees the tool message produced from the failed call.
    const round1 = seen[1]!;
    const toolMessage = round1.find(
      (m) => m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'c1',
    ) as { content: string } | undefined;
    expect(toolMessage).toBeDefined();
    // Generic error shape (NOT the confirmation-declined directive text).
    expect(toolMessage!.content).toBe(
      JSON.stringify({ error: 'No registered function named "nonexistent"' }),
    );
  });

  it('compacts a large tool result before sending it back to the LLM', async () => {
    // A tool that returns a large blob (e.g. a base64 PNG data URL) alongside
    // short metadata. The full result must NOT be sent verbatim to the model —
    // it bloats the request and can abort the next stream. Short fields pass
    // through; the long string is replaced with a truncation marker.
    registry.register({
      name: 'bigBlob',
      description: 'Returns a large blob plus metadata',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => ({
        dataUrl: 'data:image/png;base64,' + 'A'.repeat(5000),
        size: 256,
        modules: 21,
        version: 1,
        errorCorrectionLevel: 'M',
      }),
    });
    const seen: LLMMessage[][] = [];
    const deps = seqDeps(
      registry,
      audit,
      baseConfig,
      [{ message: toolCall('c1', 'bigBlob', {}) }, { message: finalMsg('done') }],
      seen,
    );

    await runToolLoop(deps, 'make a qr');

    const round1 = seen[1]!;
    const toolMessage = round1.find(
      (m) => m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'c1',
    ) as { content: string } | undefined;
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!.content) as Record<string, unknown>;

    // Short metadata survives untouched.
    expect(parsed).toMatchObject({
      size: 256,
      modules: 21,
      version: 1,
      errorCorrectionLevel: 'M',
      __omitted: true,
    });
    // The 5000-char data URL is elided with a success message (not "truncated",
    // which reads as incomplete and makes the model regenerate the QR).
    expect(parsed.dataUrl).toMatch(/^\[omitted: \d+-char payload — tool succeeded/);
    expect(toolMessage!.content.length).toBeLessThan(500);
  });

  it('sends small tool results through unchanged', async () => {
    const seen: LLMMessage[][] = [];
    const deps = seqDeps(
      registry,
      audit,
      baseConfig,
      [{ message: toolCall('c1', 'echo', {}) }, { message: finalMsg('done') }],
      seen,
    );

    await runToolLoop(deps, 'hi');

    const round1 = seen[1]!;
    const toolMessage = round1.find(
      (m) => m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'c1',
    ) as { content: string } | undefined;
    expect(toolMessage!.content).toBe(JSON.stringify('pong'));
  });

  it('replaces a wide flat object (over cap, no field individually elided) with one omission marker', async () => {
    // 100 fields × 50-char strings → ~5.9k chars JSON, over the 4000 cap, but no
    // field exceeds MAX_STRING_CHARS (200) and there are no arrays — so the
    // compact form is still over the cap and the whole payload is replaced with a
    // single bounded marker (the full value is in the audit log).
    const wide: Record<string, string> = {};
    for (let i = 0; i < 100; i++) wide[`k${i}`] = 'x'.repeat(50);
    registry.register({
      name: 'wideFlat',
      description: 'wide',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => wide,
    });
    const seen: LLMMessage[][] = [];
    const deps = seqDeps(
      registry,
      audit,
      baseConfig,
      [{ message: toolCall('c1', 'wideFlat', {}) }, { message: finalMsg('done') }],
      seen,
    );

    await runToolLoop(deps, 'dump');

    const round1 = seen[1]!;
    const toolMessage = round1.find(
      (m) => m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'c1',
    ) as { content: string } | undefined;
    expect(toolMessage).toBeDefined();
    // The fallback is a single JSON-string omission marker — bounded.
    expect(toolMessage!.content.length).toBeLessThan(500);
    const parsed = JSON.parse(toolMessage!.content) as string;
    expect(parsed).toMatch(/^\[omitted: \d+-char payload — tool succeeded/);
  });

  it('tags a top-level oversized array with __omitted (consistent with objects)', async () => {
    registry.register({
      name: 'bigArray',
      description: 'big array',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      // 1500 ints → ~6.4k chars JSON, over the 4000 cap → array (>20) is summarized.
      handler: () => Array.from({ length: 1500 }, (_, i) => i),
    });
    const seen: LLMMessage[][] = [];
    const deps = seqDeps(
      registry,
      audit,
      baseConfig,
      [{ message: toolCall('c1', 'bigArray', {}) }, { message: finalMsg('done') }],
      seen,
    );

    await runToolLoop(deps, 'list');

    const round1 = seen[1]!;
    const toolMessage = round1.find(
      (m) => m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'c1',
    ) as { content: string } | undefined;
    expect(toolMessage).toBeDefined();
    const parsed = JSON.parse(toolMessage!.content) as Record<string, unknown>;
    expect(parsed).toEqual({ length: 1500, sample: [0, 1, 2], __omitted: true });
  });

  it('sends a large result verbatim when compactResultForLLM is false', async () => {
    registry.register({
      name: 'docFetcher',
      description: 'fetch a doc',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      compactResultForLLM: false,
      handler: () => ({ text: 'A'.repeat(5000) }),
    });
    const seen: LLMMessage[][] = [];
    const deps = seqDeps(
      registry,
      audit,
      baseConfig,
      [{ message: toolCall('c1', 'docFetcher', {}) }, { message: finalMsg('done') }],
      seen,
    );

    await runToolLoop(deps, 'summarize');

    const round1 = seen[1]!;
    const toolMessage = round1.find(
      (m) => m.role === 'tool' && 'tool_call_id' in m && m.tool_call_id === 'c1',
    ) as { content: string } | undefined;
    expect(toolMessage).toBeDefined();
    // Opted out of compaction → the full 5000-char text is relayed verbatim.
    expect(toolMessage!.content.length).toBeGreaterThan(5000);
    expect(toolMessage!.content).toContain('AAAA');
    expect(toolMessage!.content).not.toContain('omitted');
  });

  it('truncates immediately and records max_tool_rounds_reached when maxToolRounds is 0', async () => {
    const callLLM = vi.fn();
    const deps: ToolLoopDeps = {
      callLLM,
      registry,
      audit,
      config: baseConfig,
      maxToolRounds: 0,
      loopRetries: 1,
    };

    const result = await runToolLoop(deps, 'hi');

    expect(callLLM).not.toHaveBeenCalled();
    expect(result.truncated).toBe(true);
    expect(result.response).toBe('');
    expect(result.toolCallsExecuted).toHaveLength(0);
    expect(audit.getAll().some((e) => e.type === 'max_tool_rounds_reached')).toBe(true);
  });

  it('records a single max_tool_rounds_reached event when the cap is hit', async () => {
    const deps = seqDeps(
      registry,
      audit,
      baseConfig,
      [{ message: toolCall('c1', 'echo', {}) }],
      [],
      3,
    );

    const result = await runToolLoop(deps, 'hi');

    expect(result.truncated).toBe(true);
    expect(result.toolCallsExecuted).toHaveLength(3);
    const maxEvents = audit.getAll().filter((e) => e.type === 'max_tool_rounds_reached');
    expect(maxEvents).toHaveLength(1);
    expect(maxEvents[0]!.error).toContain('Exceeded 3');
  });

  it('assembles system prompt, history, and the new user message in order', async () => {
    const seen: LLMMessage[][] = [];
    const deps = seqDeps(
      registry,
      audit,
      { ...baseConfig, systemPrompt: 'You are helpful.' },
      [{ message: finalMsg('ok') }],
      seen,
    );

    await runToolLoop(deps, 'now', undefined, [
      { role: 'user', content: 'earlier' },
      { role: 'assistant', content: 'noted' },
    ]);

    const first = seen[0]!;
    expect(first.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(first.map((m) => m.content)).toEqual(['You are helpful.', 'earlier', 'noted', 'now']);
  });

  it('returns an empty response when the final message has null content', async () => {
    const deps = seqDeps(registry, audit, baseConfig, [{ message: finalMsg(null) }], []);

    const result = await runToolLoop(deps, 'hi');

    expect(result.truncated).toBe(false);
    expect(result.response).toBe('');
  });
});

// ─── P1.2: loop-level round recovery ────────────────────────────────────────

/**
 * Config with the loop-level backoff dialed way down so retry tests don't wait
 * on real timers. Reuses the HTTP-layer backoff knobs the loop reads.
 */
const fastBackoffConfig: ForgewispConfig = {
  ...baseConfig,
  http: { retryBackoffBaseMs: 1, retryBackoffMaxMs: 2 },
};

/** A retryable transient HTTP failure (503, would have exhausted HTTP layer). */
const transientError = new HttpError(503, 'upstream busy', true);

describe('runToolLoop — round recovery (P1.2)', () => {
  let registry: FunctionRegistry;
  let audit: AuditLog;

  beforeEach(() => {
    registry = new FunctionRegistry();
    audit = new AuditLog();
    registry.register({
      name: 'echo',
      description: 'Echo',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => 'pong',
    });
  });

  it('retries a transient HttpError once and succeeds on the second attempt', async () => {
    const callLLM = vi.fn();
    // First attempt of round 0 rejects transiently; the retry succeeds with a
    // final response (no tool calls), so the loop terminates normally.
    callLLM.mockRejectedValueOnce(transientError).mockResolvedValueOnce({
      message: finalMsg('recovered'),
      reasoning: '',
    });

    const deps: ToolLoopDeps = {
      callLLM,
      registry,
      audit,
      config: fastBackoffConfig,
      maxToolRounds: 5,
      loopRetries: 1,
    };

    const result = await runToolLoop(deps, 'hi');

    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(result.failed).toBeUndefined();
    expect(result.truncated).toBe(false);
    expect(result.response).toBe('recovered');
    // No run_failed event — the round recovered.
    expect(audit.getAll().some((e) => e.type === 'run_failed')).toBe(false);
  });

  it('returns a failed result with partial state for a terminal (non-retryable) error', async () => {
    // Round 0 succeeds with a tool call (executed), round 1 fails terminally.
    const callLLM = vi.fn();
    callLLM
      .mockResolvedValueOnce({ message: toolCall('c1', 'echo', {}), reasoning: 'r0' })
      .mockRejectedValueOnce(new HttpError(400, 'bad request', false));

    const deps: ToolLoopDeps = {
      callLLM,
      registry,
      audit,
      config: {
        ...fastBackoffConfig,
        streaming: { reasoning: { mode: 'tag-based', tag: 'thinking' } },
      },
      maxToolRounds: 5,
      loopRetries: 1,
    };

    const result = await runToolLoop(deps, 'hi');

    // Non-retryable → exactly one attempt at round 1 (no retry).
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.response).toBe('');
    expect(result.error).toContain('400');
    // Partial state: reasoning from round 0 + the executed tool call survive.
    expect(result.reasoning).toBeDefined();
    expect(result.reasoning!.text).toBe('r0');
    expect(result.toolCallsExecuted).toHaveLength(1);
    expect(result.toolCallsExecuted[0]?.functionName).toBe('echo');
    // run_failed was audited with the error message.
    const failed = audit.getAll().filter((e) => e.type === 'run_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toContain('400');
  });

  it('exhausts the loop retry budget on a persistent transient error, then records run_failed', async () => {
    const callLLM = vi.fn().mockRejectedValue(transientError);

    const deps: ToolLoopDeps = {
      callLLM,
      registry,
      audit,
      config: fastBackoffConfig,
      maxToolRounds: 5,
      loopRetries: 1,
    };

    const result = await runToolLoop(deps, 'hi');

    // 1 initial attempt + 1 loop-level retry = 2 total callLLM invocations.
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.error).toContain('503');
    expect(audit.getAll().filter((e) => e.type === 'run_failed')).toHaveLength(1);
  });

  it('does not retry when loopRetries is 0', async () => {
    const callLLM = vi.fn().mockRejectedValue(transientError);

    const deps: ToolLoopDeps = {
      callLLM,
      registry,
      audit,
      config: fastBackoffConfig,
      maxToolRounds: 5,
      loopRetries: 0,
    };

    const result = await runToolLoop(deps, 'hi');

    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(true);
    expect(audit.getAll().filter((e) => e.type === 'run_failed')).toHaveLength(1);
  });

  it('records run_failed with a concrete error string when loopRetries is NaN (loop never entered)', async () => {
    // A NaN loopRetries makes `attempt <= loopRetries` false on iteration 0, so
    // callLLM is never invoked and lastError stays undefined. The run must still
    // record run_failed with a real string — not the JS value `undefined` that
    // JSON.stringify(undefined) would produce — so consumers reading
    // result.error / the audit event get a usable message and `result.error
    // .includes(...)` doesn't throw a TypeError.
    const callLLM = vi.fn();
    const deps: ToolLoopDeps = {
      callLLM,
      registry,
      audit,
      config: fastBackoffConfig,
      maxToolRounds: 5,
      loopRetries: Number.NaN,
    };

    const result = await runToolLoop(deps, 'hi');

    expect(callLLM).not.toHaveBeenCalled();
    expect(result.failed).toBe(true);
    expect(typeof result.error).toBe('string');
    expect(result.error).toBe('[Forgewisp] Unknown error.');
    const failed = audit.getAll().filter((e) => e.type === 'run_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toBe('[Forgewisp] Unknown error.');
  });

  it('preserves the original Error stack on the run_failed audit event', async () => {
    // A programming bug (here a stand-in TypeError) caught by the loop's
    // terminal-failure path is laundered into { failed: true } with only the
    // message in `error` — but the stack must survive on the audit event so the
    // bug is debuggable from the audit export.
    const bug = new TypeError('cannot read properties of undefined');
    const callLLM = vi.fn().mockRejectedValue(bug);

    const deps: ToolLoopDeps = {
      callLLM,
      registry,
      audit,
      config: fastBackoffConfig,
      maxToolRounds: 5,
      loopRetries: 1,
    };

    const result = await runToolLoop(deps, 'hi');

    expect(result.failed).toBe(true);
    expect(result.error).toBe('cannot read properties of undefined');
    const failed = audit.getAll().filter((e) => e.type === 'run_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.errorStack).toBe(bug.stack);
  });

  it('rethrows on a user/run abort without recording run_failed', async () => {
    const ac = new AbortController();
    ac.abort(new Error('user canceled'));
    // callLLM surfaces an abort-like error (mirrors http.ts `abortError`).
    const callLLM = vi.fn().mockRejectedValue(new Error('[Forgewisp] Aborted.'));

    const deps: ToolLoopDeps = {
      callLLM,
      registry,
      audit,
      config: fastBackoffConfig,
      maxToolRounds: 5,
      loopRetries: 1,
    };

    await expect(runToolLoop(deps, 'hi', ac.signal)).rejects.toThrow('[Forgewisp] Aborted.');
    expect(callLLM).toHaveBeenCalledTimes(1);
    // An abort is not a failure — never audited as run_failed.
    expect(audit.getAll().some((e) => e.type === 'run_failed')).toBe(false);
  });

  it('propagates an abort that fires during the backoff sleep (not audited as run_failed)', async () => {
    vi.useFakeTimers();
    try {
      const ac = new AbortController();
      // First attempt fails transiently (signal not yet aborted) so the loop
      // enters the backoff sleep; the user then aborts mid-sleep.
      const callLLM = vi.fn().mockRejectedValue(transientError);

      // Large backoff so the sleep stays parked under fake timers and the abort
      // lands mid-sleep (rather than the timer firing on advance(0)).
      const parkedConfig: ForgewispConfig = {
        ...baseConfig,
        http: { retryBackoffBaseMs: 10_000, retryBackoffMaxMs: 10_000 },
      };

      const deps: ToolLoopDeps = {
        callLLM,
        registry,
        audit,
        config: parkedConfig,
        maxToolRounds: 5,
        loopRetries: 1,
      };

      const p = runToolLoop(deps, 'hi', ac.signal);
      // Flush microtasks so the rejection is caught and the loop is now parked
      // in the backoff sleep (a fake-timer setTimeout).
      await vi.advanceTimersByTimeAsync(0);
      // Abort during the sleep — the sleep's abort listener rejects with the
      // abort reason, which propagates out of runToolLoop.
      ac.abort(new Error('canceled mid-backoff'));

      await expect(p).rejects.toThrow('canceled mid-backoff');
      expect(callLLM).toHaveBeenCalledTimes(1);
      expect(audit.getAll().some((e) => e.type === 'run_failed')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
