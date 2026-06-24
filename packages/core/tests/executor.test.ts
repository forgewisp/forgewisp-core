import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeToolCalls } from '../src/executor.js';
import { FunctionRegistry } from '../src/registry.js';
import { AuditLog } from '../src/audit.js';
import { ForgewispConfig } from '../src/types.js';
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
    // First handler sleeps 50ms; second is instant. Sequential execution would
    // take ≥100ms; concurrent must come in well under that.
    const slow = vi
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ who: 'slow' }), 50)),
      );
    const fast = vi.fn().mockResolvedValue({ who: 'fast' });
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

    const start = Date.now();
    const { executed, toolResults } = await executeToolCalls(
      [makeToolCall('slow', {}), makeToolCall('fast', {})],
      registry,
      audit,
      baseConfig,
    );
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(100);
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
});
