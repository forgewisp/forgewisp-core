// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  PLAN_STORE_KEY,
  addPlanItem,
  createPlan,
  deletePlan,
  genId,
  getPlan,
  listPlans,
  loadAll,
  nowIso,
  removePlanItem,
  updatePlanItem,
} from '../src/plan-store.js';

describe('plan-store utilities', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('genId returns distinct UUID-shaped strings', () => {
    const a = genId();
    const b = genId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(b).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it('nowIso returns a parseable ISO timestamp', () => {
    expect(new Date(nowIso()).getTime()).not.toBeNaN();
  });
});

describe('plan-store load/save', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('loadAll returns an empty record when the key is absent', () => {
    expect(loadAll()).toEqual({});
  });

  it('loadAll returns an empty record on corrupt JSON', () => {
    localStorage.setItem(PLAN_STORE_KEY, 'not valid json {{{');
    expect(loadAll()).toEqual({});
  });

  it('loadAll returns an empty record on a non-object blob', () => {
    localStorage.setItem(PLAN_STORE_KEY, JSON.stringify([1, 2, 3]));
    expect(loadAll()).toEqual({});
  });
});

describe('plan-store domain operations', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('createPlan persists a plan with generated id and seeded items', () => {
    const plan = createPlan('Weekend trip', [
      { title: 'Book flight', priority: 'high' },
      { title: 'Pack bags' },
    ]);
    expect(plan.title).toBe('Weekend trip');
    expect(plan.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]).toMatchObject({ title: 'Book flight', status: 'todo', priority: 'high' });
    expect(plan.items[1]).toMatchObject({ title: 'Pack bags', status: 'todo' });
    expect(plan.items[1]?.priority).toBeUndefined();

    const reloaded = loadAll();
    expect(reloaded[plan.id]?.title).toBe('Weekend trip');
  });

  it('createPlan throws on an empty title', () => {
    expect(() => createPlan('')).toThrow(/title must not be empty/);
  });

  it('listPlans returns compact summaries with item and done counts', () => {
    const plan = createPlan('Launch', [{ title: 'A' }, { title: 'B' }]);
    addPlanItem(plan.id, { title: 'C' });
    updatePlanItem(plan.id, plan.items[0]!.id, { status: 'done' });

    const summaries = listPlans();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: plan.id,
      title: 'Launch',
      itemCount: 3,
      doneCount: 1,
    });
  });

  it('getPlan throws on an unknown plan id', () => {
    expect(() => getPlan('nope')).toThrow(/No plan with id "nope"/);
  });

  it('addPlanItem appends an item with starting status todo and persists it', () => {
    const plan = createPlan('P', [{ title: 'first' }]);
    const item = addPlanItem(plan.id, { title: 'second', priority: 'medium', notes: 'n' });
    expect(item).toMatchObject({ title: 'second', status: 'todo', priority: 'medium', notes: 'n' });
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);

    const reloaded = getPlan(plan.id);
    expect(reloaded.items.map((i) => i.title)).toEqual(['first', 'second']);
  });

  it('addPlanItem throws on an unknown plan', () => {
    expect(() => addPlanItem('nope', { title: 'x' })).toThrow(/No plan with id/);
  });

  it('updatePlanItem applies provided fields only', () => {
    const plan = createPlan('P', [{ title: 'A', priority: 'low' }]);
    const itemId = plan.items[0]!.id;
    const updated = updatePlanItem(plan.id, itemId, { status: 'done', priority: 'high' });
    expect(updated).toMatchObject({ title: 'A', status: 'done', priority: 'high' });

    const again = updatePlanItem(plan.id, itemId, { notes: 'finished early' });
    // Untouched fields are preserved across separate updates.
    expect(again).toMatchObject({ status: 'done', priority: 'high', notes: 'finished early' });
  });

  it('updatePlanItem throws on an empty patch', () => {
    const plan = createPlan('P', [{ title: 'A' }]);
    expect(() => updatePlanItem(plan.id, plan.items[0]!.id, {})).toThrow(
      /at least one field to update/,
    );
  });

  it('updatePlanItem throws on an unknown item', () => {
    const plan = createPlan('P', [{ title: 'A' }]);
    expect(() => updatePlanItem(plan.id, 'missing', { status: 'done' })).toThrow(
      /No item with id "missing"/,
    );
  });

  it('removePlanItem removes the item and reports whether it existed', () => {
    const plan = createPlan('P', [{ title: 'A' }, { title: 'B' }]);
    const aId = plan.items[0]!.id;
    expect(removePlanItem(plan.id, aId)).toEqual({ removed: true, existed: true });
    expect(getPlan(plan.id).items.map((i) => i.title)).toEqual(['B']);
    // Removing again reports existed: false but does not throw.
    expect(removePlanItem(plan.id, aId)).toEqual({ removed: true, existed: false });
  });

  it('removePlanItem throws on an unknown plan', () => {
    expect(() => removePlanItem('nope', 'whatever')).toThrow(/No plan with id/);
  });

  it('deletePlan removes the whole plan and reports whether it existed', () => {
    const plan = createPlan('P', [{ title: 'A' }]);
    expect(deletePlan(plan.id)).toEqual({ removed: true, existed: true });
    expect(listPlans()).toHaveLength(0);
    expect(deletePlan(plan.id)).toEqual({ removed: true, existed: false });
  });
});
