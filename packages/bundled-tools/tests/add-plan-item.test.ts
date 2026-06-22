// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { addPlanItem } from '../src/tools/add-plan-item.js';
import type { AddPlanItemResult } from '../src/tools/add-plan-item.js';
import { createPlan } from '../src/tools/create-plan.js';
import type { CreatePlanResult } from '../src/tools/create-plan.js';

describe('addPlanItem', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(addPlanItem.name).toBe('addPlanItem');
    expect(addPlanItem.riskTier).toBe('read');
    expect(typeof addPlanItem.handler).toBe('function');

    const { parameters } = addPlanItem;
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['planId', 'title']);
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.properties.priority?.enum).toEqual(['low', 'medium', 'high']);
  });

  it('adds an item with optional priority and notes', () => {
    const created = createPlan.handler({ title: 'P' }) as CreatePlanResult;
    const result = addPlanItem.handler({
      planId: created.plan.id,
      title: 'Call mom',
      priority: 'high',
      notes: 'afternoon',
    }) as AddPlanItemResult;

    expect(result.item).toMatchObject({
      title: 'Call mom',
      status: 'todo',
      priority: 'high',
      notes: 'afternoon',
    });
  });

  it('throws on an unknown plan', () => {
    expect(() => addPlanItem.handler({ planId: 'nope', title: 'x' })).toThrow(/No plan with id/);
  });
});
