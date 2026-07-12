import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeToolCalls } from '../src/executor.js';
import { FunctionRegistry } from '../src/registry.js';
import { AuditLog } from '../src/audit.js';
import { ForgewispConfig, JSONSchema } from '../src/types.js';
import type { LLMToolCall } from '../src/wire.js';

const makeToolCall = (name: string, args: Record<string, unknown>): LLMToolCall => ({
  id: `call_${Math.random().toString(36).slice(2)}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const baseConfig: ForgewispConfig = {
  llmEndpoint: 'https://api.example.com/v1/chat/completions',
  model: 'gpt-4o',
};

describe('executeToolCalls', () => {
  let registry: FunctionRegistry;
  let audit: AuditLog;

  beforeEach(() => {
    registry = new FunctionRegistry();
    audit = new AuditLog();
  });

  it('executes a read-tier function without confirmation', async () => {
    const handler = vi.fn().mockResolvedValue({ result: 'ok' });
    registry.register({
      name: 'readData',
      description: 'Read',
      riskTier: 'read',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler,
    });

    const { executed, aborted } = await executeToolCalls(
      [makeToolCall('readData', { id: '123' })],
      registry,
      audit,
      baseConfig,
    );

    expect(handler).toHaveBeenCalledWith({ id: '123' }, { signal: undefined });
    expect(executed).toHaveLength(1);
    expect(aborted).toHaveLength(0);
  });

  it('threads the run AbortSignal into the handler context', async () => {
    const handler = vi.fn().mockResolvedValue({ result: 'ok' });
    registry.register({
      name: 'readData',
      description: 'Read',
      riskTier: 'read',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler,
    });

    const controller = new AbortController();
    await executeToolCalls(
      [makeToolCall('readData', { id: '123' })],
      registry,
      audit,
      baseConfig,
      controller.signal,
    );

    expect(handler).toHaveBeenCalledWith({ id: '123' }, { signal: controller.signal });
  });

  it('calls onConfirmRequired for write-tier and executes if accepted', async () => {
    const handler = vi.fn().mockResolvedValue('done');
    registry.register({
      name: 'writeData',
      description: 'Write',
      riskTier: 'write',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      handler,
    });

    const onConfirmRequired = vi.fn().mockResolvedValue(true);
    const { executed } = await executeToolCalls(
      [makeToolCall('writeData', { value: 'hello' })],
      registry,
      audit,
      { ...baseConfig, onConfirmRequired },
    );

    expect(onConfirmRequired).toHaveBeenCalledOnce();
    expect(executed).toHaveLength(1);
  });

  it('aborts destructive function if confirmation rejected', async () => {
    const handler = vi.fn();
    registry.register({
      name: 'deleteItem',
      description: 'Delete',
      riskTier: 'destructive',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler,
    });

    const onConfirmRequired = vi.fn().mockResolvedValue(false);
    const { executed, aborted } = await executeToolCalls(
      [makeToolCall('deleteItem', { id: 'x' })],
      registry,
      audit,
      { ...baseConfig, onConfirmRequired },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(aborted[0]!.reason).toBe('confirmation_rejected');
    expect(executed).toHaveLength(0);
  });

  it('aborts if validation fails', async () => {
    const handler = vi.fn();
    registry.register({
      name: 'strictFn',
      description: 'Strict',
      riskTier: 'read',
      parameters: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 1 } },
        required: ['count'],
      },
      handler,
    });

    const { aborted } = await executeToolCalls(
      [makeToolCall('strictFn', { count: -5 })],
      registry,
      audit,
      baseConfig,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(aborted[0]!.reason).toBe('validation_failed');
  });

  it('aborts for unknown function name', async () => {
    const { aborted } = await executeToolCalls(
      [makeToolCall('nonexistent', {})],
      registry,
      audit,
      baseConfig,
    );
    expect(aborted[0]!.reason).toBe('validation_failed');
  });

  it('default-denies a destructive tool when no onConfirmRequired is configured', async () => {
    const handler = vi.fn();
    registry.register({
      name: 'del',
      description: 'Delete',
      riskTier: 'destructive',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      handler,
    });

    const { executed, aborted, toolResults } = await executeToolCalls(
      [makeToolCall('del', { id: 'x' })],
      registry,
      audit,
      baseConfig,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);
    expect(aborted[0]!.reason).toBe('no_confirmation_handler');
    expect(toolResults[0]!.success).toBe(false);
    expect(toolResults[0]!.abortReason).toBe('no_confirmation_handler');
  });

  it('treats a throwing onConfirmRequired as handler_errored and continues', async () => {
    const handler = vi.fn();
    registry.register({
      name: 'w',
      description: 'Write',
      riskTier: 'write',
      parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] },
      handler,
    });

    const onConfirmRequired = vi.fn().mockRejectedValue(new Error('nope'));
    const { executed, aborted } = await executeToolCalls(
      [makeToolCall('w', { v: 'a' })],
      registry,
      audit,
      { ...baseConfig, onConfirmRequired },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);
    expect(aborted[0]!.reason).toBe('handler_errored');
    expect(aborted[0]!.error).toContain('nope');
  });

  it('records handler errors in both aborted and toolResults', async () => {
    registry.register({
      name: 'boom',
      description: 'Boom',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: vi.fn().mockRejectedValue(new Error('kaboom')),
    });

    const { executed, aborted, toolResults } = await executeToolCalls(
      [makeToolCall('boom', {})],
      registry,
      audit,
      baseConfig,
    );

    expect(executed).toHaveLength(0);
    expect(aborted[0]!.reason).toBe('handler_errored');
    expect(aborted[0]!.error).toContain('kaboom');
    expect(toolResults[0]!.success).toBe(false);
    expect(toolResults[0]!.abortReason).toBe('handler_errored');
  });

  it('runs independent tool calls concurrently and preserves audit order', async () => {
    // Prove concurrency structurally rather than with a wall-clock threshold:
    // the `slow` handler stays in-flight (started, not yet resolved) while the
    // `fast` handler runs. Under sequential execution `slow` would have fully
    // resolved before `fast` started, so `fastRanDuringSlow` could not be set.
    // This is deterministic and immune to CI timer/scheduling jitter, which a
    // `<100ms` wall-clock assertion is not.
    let slowStarted = false;
    let slowResolved = false;
    const slow = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          slowStarted = true;
          setTimeout(() => {
            slowResolved = true;
            resolve({ who: 'slow' });
          }, 50);
        }),
    );
    let fastRanDuringSlow = false;
    const fast = vi.fn().mockImplementation(() => {
      if (slowStarted && !slowResolved) fastRanDuringSlow = true;
      return Promise.resolve({ who: 'fast' });
    });
    registry.register({
      name: 'slow',
      description: 'Slow',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: slow,
    });
    registry.register({
      name: 'fast',
      description: 'Fast',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: fast,
    });

    const { executed, toolResults } = await executeToolCalls(
      [makeToolCall('slow', {}), makeToolCall('fast', {})],
      registry,
      audit,
      baseConfig,
    );

    expect(fastRanDuringSlow).toBe(true);
    expect(executed).toHaveLength(2);
    // Input order preserved in result arrays even though fast finished first.
    expect(toolResults[0]!.functionName).toBe('slow');
    expect(toolResults[1]!.functionName).toBe('fast');

    // Audit log: function_executed for slow before fast (input order, not
    // completion order).
    const executedEvents = audit.getAll().filter((e) => e.type === 'function_executed');
    expect(executedEvents).toHaveLength(2);
    expect(executedEvents[0]!.functionName).toBe('slow');
    expect(executedEvents[1]!.functionName).toBe('fast');
  });

  it('aborts with validation_failed when arguments are not valid JSON', async () => {
    const handler = vi.fn();
    registry.register({
      name: 'fn',
      description: 'Fn',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler,
    });

    const bad: LLMToolCall = {
      id: 'c1',
      type: 'function',
      function: { name: 'fn', arguments: '{not valid json' },
    };
    const { aborted, toolResults } = await executeToolCalls([bad], registry, audit, baseConfig);

    expect(handler).not.toHaveBeenCalled();
    expect(aborted[0]!.reason).toBe('validation_failed');
    expect(aborted[0]!.error).toContain('Failed to parse arguments JSON');
    expect(toolResults[0]!.success).toBe(false);
  });

  it('records function_executed in audit log on success', async () => {
    registry.register({
      name: 'ok',
      description: 'Ok',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: vi.fn().mockResolvedValue('done'),
    });

    await executeToolCalls([makeToolCall('ok', {})], registry, audit, baseConfig);

    const types = audit.getAll().map((e) => e.type);
    expect(types).toContain('function_requested');
    expect(types).toContain('validation_passed');
    expect(types).toContain('function_executed');
  });

  it('skips a call whose schema Ajv rejects at compile time and continues the run (P1.5 backstop)', async () => {
    // Defense-in-depth backstop for the validateArgs compile-error path. The
    // PRIMARY gate is registration-time: `agent.registerFunction` calls
    // `compileSchema` and rejects a malformed schema before it enters the
    // registry (see agent.test.ts). This test bypasses that gate by
    // registering directly on the `FunctionRegistry` (the path a directly-used
    // registry or a future bypass would take) and proves the executor still
    // does not crash: `validateArgs` catches the Ajv compile throw and emits
    // `validation_failed` so the run continues. The schema is constructed via
    // `as unknown as JSONSchema` precisely because it is not representable in
    // the typed surface — that's the whole gap.
    const brokenHandler = vi.fn().mockResolvedValue('should-not-run');
    registry.register({
      name: 'broken',
      description: 'Broken schema',
      riskTier: 'read',
      parameters: {
        type: 'object',
        properties: { x: { $ref: '#/definitions/Nonexistent' } },
        required: ['x'],
      } as unknown as JSONSchema,
      handler: brokenHandler,
    });
    const goodHandler = vi.fn().mockResolvedValue('ok');
    registry.register({
      name: 'good',
      description: 'Good schema',
      riskTier: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: goodHandler,
    });

    const { executed, aborted, toolResults } = await executeToolCalls(
      [makeToolCall('broken', { x: 1 }), makeToolCall('good', {})],
      registry,
      audit,
      baseConfig,
    );

    // The broken call is skipped, not retried; its handler never runs.
    expect(brokenHandler).not.toHaveBeenCalled();
    expect(aborted).toHaveLength(1);
    expect(aborted[0]!.functionName).toBe('broken');
    expect(aborted[0]!.reason).toBe('validation_failed');
    expect(aborted[0]!.error).toMatch(/Schema compile failed/);
    expect(aborted[0]!.error).toMatch(/Nonexistent/);

    // The run continues: the sibling valid call still executes.
    expect(goodHandler).toHaveBeenCalledOnce();
    expect(executed).toHaveLength(1);
    expect(executed[0]!.functionName).toBe('good');

    // The broken call's tool result is carried back (success: false) so the
    // loop can relay the failure to the model.
    expect(toolResults).toHaveLength(2);
    const brokenResult = toolResults.find((r) => r.functionName === 'broken');
    expect(brokenResult!.success).toBe(false);
    expect(brokenResult!.abortReason).toBe('validation_failed');

    // `validation_failed` is audited with the schema compile error.
    const failedEvent = audit.getAll().find((e) => e.type === 'validation_failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent!.functionName).toBe('broken');
    expect(failedEvent!.error).toMatch(/Schema compile failed/);
  });
});
