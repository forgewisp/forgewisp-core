// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { updatePlanItem } from '../src/tools/update-plan-item.js';
import type { UpdatePlanItemResult } from '../src/tools/update-plan-item.js';
import { createPlan } from '../src/tools/create-plan.js';
import type { CreatePlanResult } from '../src/tools/create-plan.js';

describe('updatePlanItem', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(updatePlanItem.name).toBe('updatePlanItem');
    expect(updatePlanItem.riskTier).toBe('read');
    expect(typeof updatePlanItem.handler).toBe('function');

    const { parameters } = updatePlanItem;
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['planId', 'itemId']);
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.properties.status?.enum).toEqual(['todo', 'in_progress', 'done']);
  });

  it('updates status and preserves untouched fields', () => {
    const created = createPlan.handler({
      title: 'P',
      items: [{ title: 'A', priority: 'low' }],
    }) as CreatePlanResult;
    const itemId = created.plan.items[0]!.id;

    const result = updatePlanItem.handler({
      planId: created.plan.id,
      itemId,
      status: 'done',
    }) as UpdatePlanItemResult;

    expect(result.item).toMatchObject({ title: 'A', status: 'done', priority: 'low' });
  });

  it('clears notes when passed an empty string', () => {
    const created = createPlan.handler({
      title: 'P',
      items: [{ title: 'A' }],
    }) as CreatePlanResult;
    const itemId = created.plan.items[0]!.id;

    updatePlanItem.handler({ planId: created.plan.id, itemId, notes: 'temp' });
    const result = updatePlanItem.handler({
      planId: created.plan.id,
      itemId,
      notes: '',
    }) as UpdatePlanItemResult;

    expect(result.item.notes).toBe('');
  });

  it('throws on an empty patch', () => {
    const created = createPlan.handler({ title: 'P', items: [{ title: 'A' }] }) as CreatePlanResult;
    expect(() =>
      updatePlanItem.handler({ planId: created.plan.id, itemId: created.plan.items[0]!.id }),
    ).toThrow(/at least one field to update/);
  });
});
