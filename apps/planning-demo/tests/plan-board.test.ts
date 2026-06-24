import { describe, it, expect, beforeEach } from 'vitest';
import { PlanBoard } from '../src/plan-board.js';
import type { AuditEvent } from '@forgewisp/core';
import type { Plan } from '@forgewisp/bundled-tools';

// Helper to build a minimal function_executed audit event for a plan tool.
function executed(
  functionName: string,
  args: Record<string, unknown>,
  result: unknown,
): AuditEvent {
  return {
    id: `${functionName}-${Math.random().toString(36).slice(2)}`,
    timestamp: '2026-06-23T00:00:00.000Z',
    type: 'function_executed',
    functionName,
    args,
    result,
  };
}

// Fresh plan per call — the board mutates `plan.items` in place, so tests must
// not share a single plan object across `it` blocks (the mutation would leak).
function freshPlan(): Plan {
  return {
    id: 'p1',
    title: 'Saturday',
    createdAt: '2026-06-23T00:00:00.000Z',
    items: [{ id: 'i1', title: 'gym', status: 'todo', createdAt: '2026-06-23T00:00:00.000Z' }],
  };
}

describe('PlanBoard — live plan card reconstruction', () => {
  let container: HTMLUListElement;
  let board: PlanBoard;

  beforeEach(() => {
    container = document.createElement('ul');
    board = new PlanBoard(container);
  });

  it('renders a live card from createPlan', () => {
    board.applyEvent(executed('createPlan', { title: 'Saturday' }, { plan: freshPlan() }));
    const card = container.querySelector('.artifact-plan');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-plan-id')).toBe('p1');
    expect(card?.textContent).toContain('Saturday');
    expect(card?.textContent).toContain('gym');
    expect(card?.textContent).toContain('0/1 done');
  });

  it('appends an item in place (one card, count advances)', () => {
    board.applyEvent(executed('createPlan', { title: 'Saturday' }, { plan: freshPlan() }));
    board.applyEvent(
      executed(
        'addPlanItem',
        { planId: 'p1', title: 'groceries' },
        { item: { id: 'i2', title: 'groceries', status: 'todo', priority: 'high', createdAt: '' } },
      ),
    );
    expect(container.querySelectorAll('.artifact-plan').length).toBe(1);
    const card = container.querySelector('.artifact-plan');
    expect(card?.textContent).toContain('groceries');
    expect(card?.textContent).toContain('0/2 done');
  });

  it('flips an item status in place, reusing the SAME card node', () => {
    board.applyEvent(executed('createPlan', { title: 'Saturday' }, { plan: freshPlan() }));
    const before = container.querySelector('.artifact-plan');
    expect(before?.textContent).toContain('0/1 done');
    expect(before?.querySelector('.status-todo')).not.toBeNull();

    board.applyEvent(
      executed(
        'updatePlanItem',
        { planId: 'p1', itemId: 'i1' },
        { item: { id: 'i1', title: 'gym', status: 'in_progress', createdAt: '' } },
      ),
    );

    // Same <li> node, not a new card.
    const after = container.querySelector('.artifact-plan');
    expect(after).toBe(before);
    expect(after?.querySelector('.status-in_progress')).not.toBeNull();
    expect(after?.querySelector('.status-todo')).toBeNull();
  });

  it('marks done and advances the done count', () => {
    board.applyEvent(executed('createPlan', { title: 'Saturday' }, { plan: freshPlan() }));
    board.applyEvent(
      executed(
        'updatePlanItem',
        { planId: 'p1', itemId: 'i1' },
        { item: { id: 'i1', title: 'gym', status: 'done', createdAt: '' } },
      ),
    );
    const card = container.querySelector('.artifact-plan');
    expect(card?.textContent).toContain('1/1 done');
    expect(card?.querySelector('.status-done')).not.toBeNull();
  });

  it('removes an item via removePlanItem', () => {
    board.applyEvent(executed('createPlan', { title: 'Saturday' }, { plan: freshPlan() }));
    board.applyEvent(
      executed(
        'addPlanItem',
        { planId: 'p1', title: 'groceries' },
        {
          item: { id: 'i2', title: 'groceries', status: 'todo', createdAt: '' },
        },
      ),
    );
    expect(container.querySelector('.artifact-plan')?.textContent).toContain('groceries');

    board.applyEvent(
      executed('removePlanItem', { planId: 'p1', itemId: 'i2' }, { existed: true, removed: true }),
    );
    const card = container.querySelector('.artifact-plan');
    expect(card?.textContent).not.toContain('groceries');
    expect(card?.textContent).toContain('gym');
  });

  it('removes the whole card via deletePlan', () => {
    board.applyEvent(executed('createPlan', { title: 'Saturday' }, { plan: freshPlan() }));
    expect(container.querySelectorAll('.artifact-plan').length).toBe(1);

    board.applyEvent(executed('deletePlan', { planId: 'p1' }, { existed: true, removed: true }));
    expect(container.querySelectorAll('.artifact-plan').length).toBe(0);
  });

  it('ignores listPlans (summaries carry no item data)', () => {
    board.applyEvent(executed('createPlan', { title: 'Saturday' }, { plan: freshPlan() }));
    const before = container.querySelector('.artifact-plan')?.textContent;
    board.applyEvent(
      executed(
        'listPlans',
        {},
        { plans: [{ id: 'p1', title: 'Saturday', itemCount: 1, doneCount: 0, createdAt: '' }] },
      ),
    );
    expect(container.querySelector('.artifact-plan')?.textContent).toBe(before);
  });

  it('ignores non-plan and non-executed events', () => {
    board.applyEvent(executed('getCurrentTime', {}, { local: 'now' }));
    board.applyEvent({
      id: 'x',
      timestamp: '',
      type: 'function_requested',
      functionName: 'createPlan',
    });
    expect(container.children.length).toBe(0);
  });

  it('seeds a stub card when addPlanItem targets an unseen plan', () => {
    board.applyEvent(
      executed(
        'addPlanItem',
        { planId: 'mystery', title: 'step' },
        {
          item: { id: 'i9', title: 'step', status: 'todo', createdAt: '' },
        },
      ),
    );
    const card = container.querySelector('.artifact-plan');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-plan-id')).toBe('mystery');
    expect(card?.textContent).toContain('step');
  });

  it('clear() removes all cards', () => {
    board.applyEvent(executed('createPlan', { title: 'Saturday' }, { plan: freshPlan() }));
    board.clear();
    expect(container.children.length).toBe(0);
  });
});
