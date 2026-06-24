// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { removePlanItem } from '../src/tools/remove-plan-item.js';
import type { RemovePlanItemResult } from '../src/tools/remove-plan-item.js';
import { createPlan } from '../src/tools/create-plan.js';
import type { CreatePlanResult } from '../src/tools/create-plan.js';

describe('removePlanItem', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(removePlanItem.name).toBe('removePlanItem');
    expect(removePlanItem.riskTier).toBe('read');
    expect(typeof removePlanItem.handler).toBe('function');

    const { parameters } = removePlanItem;
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['planId', 'itemId']);
    expect(parameters.additionalProperties).toBe(false);
  });

  it('removes an item and reports existence', () => {
    const created = createPlan.handler({
      title: 'P',
      items: [{ title: 'A' }, { title: 'B' }],
    }) as CreatePlanResult;
    const aId = created.plan.items[0]!.id;

    const result = removePlanItem.handler({
      planId: created.plan.id,
      itemId: aId,
    }) as RemovePlanItemResult;
    expect(result).toEqual({ removed: true, existed: true });
  });

  it('throws on an unknown plan', () => {
    expect(() => removePlanItem.handler({ planId: 'nope', itemId: 'x' })).toThrow(
      /No plan with id/,
    );
  });
});
