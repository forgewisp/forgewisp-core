import { describe, it, expect, vi } from 'vitest';
import { AuditLog } from '../src/audit.js';
import type { AuditEvent } from '../src/types.js';

describe('AuditLog', () => {
  it('records events and returns them', () => {
    const log = new AuditLog();
    log.record('function_requested', 'myFn', { riskTier: 'read' });
    log.record('function_executed', 'myFn', { result: 42 });
    expect(log.getAll()).toHaveLength(2);
  });

  it('each event has a unique id and ISO timestamp', () => {
    const log = new AuditLog();
    log.record('function_requested', 'fn1');
    log.record('function_requested', 'fn2');
    const [e1, e2] = log.getAll();
    expect(e1!.id).not.toBe(e2!.id);
    expect(new Date(e1!.timestamp).toISOString()).toBe(e1!.timestamp);
  });

  it('calls onEvent callback', () => {
    const onEvent = vi.fn();
    const log = new AuditLog(onEvent);
    log.record('validation_passed', 'fn');
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it('getAll returns a copy', () => {
    const log = new AuditLog();
    log.record('function_executed', 'fn');
    const events = log.getAll();
    events.pop();
    expect(log.getAll()).toHaveLength(1);
  });

  it('exportJSON returns valid JSON', () => {
    const log = new AuditLog();
    log.record('function_executed', 'fn', { result: { x: 1 } });
    expect(() => {
      JSON.parse(log.exportJSON());
    }).not.toThrow();
  });

  it('clear removes all events', () => {
    const log = new AuditLog();
    log.record('function_executed', 'fn');
    log.clear();
    expect(log.getAll()).toHaveLength(0);
  });

  it('survives a throwing onEvent callback and records audit_callback_errored', () => {
    const onEvent = () => {
      throw new Error('boom');
    };
    const log = new AuditLog(onEvent);
    const event = log.record('function_executed', 'fn');
    expect(event.type).toBe('function_executed');
    const all = log.getAll();
    expect(all).toHaveLength(2);
    expect(all[1]!.type).toBe('audit_callback_errored');
    expect(all[1]!.error).toContain('boom');
  });

  it('survives an onEvent callback that throws a non-coercible value', () => {
    // A thrown value whose toString() throws must not escape record() — the
    // error-coercion in the audit_callback_errored path is guarded too.
    const throwingToString = {
      toString() {
        throw new Error('toString boom');
      },
    };
    const onEvent = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately throws a non-Error to verify the coercion guard
      throw throwingToString;
    };
    const log = new AuditLog(onEvent);
    const event = log.record('function_executed', 'fn');
    expect(event.type).toBe('function_executed');
    const all = log.getAll();
    expect(all[1]!.type).toBe('audit_callback_errored');
    expect(all[1]!.error).toBe('audit callback threw a non-coercible error');
  });

  it('survives a throwing redact callback, records redact_errored, and drops the offending event', () => {
    const redact = () => {
      throw new Error('redact boom');
    };
    const onEvent = vi.fn();
    const log = new AuditLog(onEvent, 1000, redact);
    const event = log.record('function_executed', 'fn', { result: { secret: 's' } });
    expect(event.type).toBe('redact_errored');
    // The redactor's raw error message is never stored — it may echo the
    // secret it was scrubbing. A fixed opaque string is recorded instead.
    expect(event.error).toBe('redact callback threw an error');
    const all = log.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.type).toBe('redact_errored');
    // The unredacted offending event is never stored.
    expect(all.find((e) => e.type === 'function_executed')).toBeUndefined();
    // redact threw, not onEvent, so the synthetic event IS delivered to onEvent
    // (a consumer whose only observability hook is onEvent must see the failure).
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'redact_errored' }));
  });

  it('does not leak the secret the redactor was scrubbing via its thrown error message', () => {
    const secret = 'sk-supersecret-1234';
    const redact = () => {
      throw new Error(`cannot scrub token: ${secret}`);
    };
    const log = new AuditLog(undefined, 1000, redact);
    const event = log.record('function_executed', 'fn', { result: { token: secret } });
    expect(event.type).toBe('redact_errored');
    expect(event.error).not.toContain(secret);
    expect(log.exportJSON()).not.toContain(secret);
  });

  it('survives a redact callback that throws a non-coercible value', () => {
    // A thrown value whose toString() throws must not escape record().
    const throwingToString = {
      toString() {
        throw new Error('toString boom');
      },
    };
    const redact = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately throws a non-Error to verify the coercion guard
      throw throwingToString;
    };
    const log = new AuditLog(undefined, 1000, redact);
    const event = log.record('function_executed', 'fn');
    expect(event.type).toBe('redact_errored');
    expect(event.error).toBe('redact callback threw an error');
    expect(log.getAll()).toHaveLength(1);
  });

  it('treats a redact callback returning a non-AuditEvent as a failure', () => {
    const redact = (): AuditEvent => null as unknown as AuditEvent;
    const onEvent = vi.fn();
    const log = new AuditLog(onEvent, 1000, redact);
    const event = log.record('function_executed', 'fn', { result: { secret: 's' } });
    expect(event.type).toBe('redact_errored');
    const all = log.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.type).toBe('redact_errored');
    // The unredacted offending event (with its secret) is never stored.
    expect(all.find((e) => e.type === 'function_executed')).toBeUndefined();
    expect(onEvent).toHaveBeenCalledOnce();
  });

  it('continues recording after a redact failure', () => {
    let calls = 0;
    const redact = (e: AuditEvent): AuditEvent => {
      calls += 1;
      if (calls === 1) throw new Error('first redact fails');
      return e;
    };
    const log = new AuditLog(undefined, 1000, redact);
    log.record('function_executed', 'fn1', { result: 'a' });
    log.record('function_executed', 'fn2', { result: 'b' });
    const all = log.getAll();
    expect(all).toHaveLength(2);
    expect(all[0]!.type).toBe('redact_errored');
    expect(all[1]!.type).toBe('function_executed');
    expect(all[1]!.functionName).toBe('fn2');
  });

  it('drops the oldest event when maxEvents is exceeded', () => {
    const log = new AuditLog(undefined, 5);
    for (let i = 0; i < 6; i++) {
      log.record('function_executed', `fn${i}`);
    }
    const all = log.getAll();
    expect(all).toHaveLength(5);
    // The oldest (fn0) should have been dropped; fn1 is now first.
    expect(all[0]!.functionName).toBe('fn1');
    expect(all[4]!.functionName).toBe('fn5');
  });

  it('defaults to the 1000-event bound', () => {
    const log = new AuditLog();
    for (let i = 0; i < 1001; i++) {
      log.record('function_executed', `fn${i}`);
    }
    expect(log.getAll()).toHaveLength(1000);
  });

  it('maxEvents <= 0 disables the bound', () => {
    const log = new AuditLog(undefined, 0);
    for (let i = 0; i < 50; i++) {
      log.record('function_executed', `fn${i}`);
    }
    expect(log.getAll()).toHaveLength(50);
  });
});
