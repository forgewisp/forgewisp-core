import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentBoard } from '../src/subagent-board.js';
import type { AuditEvent } from '@forgewisp/core';

// Minimal audit-event builder for spawnSubagent events.
function event(type: AuditEvent['type'], extras: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `${type}-${Math.random().toString(36).slice(2)}`,
    timestamp: '2026-06-24T00:00:00.000Z',
    type,
    functionName: 'spawnSubagent',
    ...extras,
  };
}

describe('SubagentBoard — live run card reconstruction', () => {
  let container: HTMLUListElement;
  let board: SubagentBoard;

  beforeEach(() => {
    container = document.createElement('ul');
    board = new SubagentBoard(container);
  });

  it('renders a spawning card from function_requested', () => {
    board.applyEvent(event('function_requested', { args: { task: 'hash the time' } }));
    const card = container.querySelector('.artifact-subagent');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('hash the time');
    expect(card?.querySelector('.status-spawning')).not.toBeNull();
  });

  it('completes the oldest pending card from function_executed', () => {
    board.applyEvent(event('function_requested', { args: { task: 'task A' } }));
    board.applyEvent(
      event('function_executed', {
        result: { response: 'A done', truncated: false, toolCallsExecuted: 3, toolCallsAborted: 0 },
      }),
    );
    expect(container.querySelectorAll('.artifact-subagent').length).toBe(1);
    const card = container.querySelector('.artifact-subagent');
    expect(card?.textContent).toContain('A done');
    expect(card?.textContent).toContain('3 tool calls');
    expect(card?.querySelector('.status-done')).not.toBeNull();
  });

  it('marks a card truncated and counts aborted calls', () => {
    board.applyEvent(event('function_requested', { args: { task: 'big task' } }));
    board.applyEvent(
      event('function_executed', {
        result: { response: '', truncated: true, toolCallsExecuted: 15, toolCallsAborted: 2 },
      }),
    );
    const card = container.querySelector('.artifact-subagent');
    expect(card?.textContent).toContain('truncated');
    expect(card?.textContent).toContain('2 aborted');
  });

  it('completes pending cards in FIFO order across concurrent spawns', () => {
    board.applyEvent(event('function_requested', { args: { task: 'first' } }));
    board.applyEvent(event('function_requested', { args: { task: 'second' } }));
    expect(container.querySelectorAll('.artifact-subagent').length).toBe(2);

    // The first completed event resolves the FIRST (oldest) pending card.
    board.applyEvent(
      event('function_executed', {
        result: { response: 'FIRST', truncated: false, toolCallsExecuted: 1, toolCallsAborted: 0 },
      }),
    );
    const cards = container.querySelectorAll('.artifact-subagent');
    // First card is done; second is still spawning. After completion the done
    // card is moved to the top, so the topmost card is "FIRST".
    expect(cards[0]?.textContent).toContain('FIRST');
    expect(cards[0]?.querySelector('.status-done')).not.toBeNull();
    expect(cards[1]?.querySelector('.status-spawning')).not.toBeNull();
    expect(cards[1]?.textContent).toContain('second');

    board.applyEvent(
      event('function_executed', {
        result: { response: 'SECOND', truncated: false, toolCallsExecuted: 0, toolCallsAborted: 0 },
      }),
    );
    expect(container.querySelectorAll('.status-spawning').length).toBe(0);
    expect(container.querySelectorAll('.status-done').length).toBe(2);
  });

  it('renders an error card from function_errored', () => {
    board.applyEvent(event('function_requested', { args: { task: 'doomed' } }));
    board.applyEvent(event('function_errored', { error: 'boom' }));
    const card = container.querySelector('.artifact-subagent');
    expect(card?.textContent).toContain('boom');
    expect(card?.querySelector('.status-error')).not.toBeNull();
  });

  it('ignores non-spawnSubagent and non-relevant events', () => {
    board.applyEvent({
      id: 'x',
      timestamp: '',
      type: 'function_executed',
      functionName: 'getCurrentTime',
      result: { local: 'now' },
    });
    board.applyEvent({
      id: 'y',
      timestamp: '',
      type: 'function_requested',
      functionName: 'spawnSubagent',
      // intentionally no args
    });
    // function_requested with no args still pushes a card (task = '').
    expect(container.children.length).toBe(1);
    // function_executed for getCurrentTime is ignored.
    expect(container.querySelectorAll('.artifact-subagent').length).toBe(1);
  });

  it('clear() removes all cards', () => {
    board.applyEvent(event('function_requested', { args: { task: 'a' } }));
    board.applyEvent(event('function_requested', { args: { task: 'b' } }));
    board.clear();
    expect(container.children.length).toBe(0);
  });

  it('function_executed with no pending card is a safe no-op', () => {
    board.applyEvent(
      event('function_executed', {
        result: { response: 'orphan', truncated: false, toolCallsExecuted: 0, toolCallsAborted: 0 },
      }),
    );
    expect(container.children.length).toBe(0);
  });
});
