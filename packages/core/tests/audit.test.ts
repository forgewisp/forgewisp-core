import { describe, it, expect, vi } from 'vitest';
import { AuditLog } from '../src/audit.js';

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
