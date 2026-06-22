// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { deletePlan } from '../src/tools/delete-plan.js';
import type { DeletePlanResult } from '../src/tools/delete-plan.js';
import { createPlan } from '../src/tools/create-plan.js';
import type { CreatePlanResult } from '../src/tools/create-plan.js';
import { listPlans } from '../src/tools/list-plans.js';
import type { ListPlansResult } from '../src/tools/list-plans.js';

describe('deletePlan', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(deletePlan.name).toBe('deletePlan');
    expect(deletePlan.riskTier).toBe('read');
    expect(typeof deletePlan.handler).toBe('function');

    const { parameters } = deletePlan;
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['planId']);
    expect(parameters.additionalProperties).toBe(false);
  });

  it('deletes an existing plan and reports existence', () => {
    const created = createPlan.handler({ title: 'P', items: [{ title: 'A' }] }) as CreatePlanResult;
    const result = deletePlan.handler({ planId: created.plan.id }) as DeletePlanResult;
    expect(result).toEqual({ removed: true, existed: true });
    expect((listPlans.handler({}) as ListPlansResult).plans).toHaveLength(0);
  });

  it('reports existed: false for an unknown plan without throwing', () => {
    const result = deletePlan.handler({ planId: 'nope' }) as DeletePlanResult;
    expect(result).toEqual({ removed: true, existed: false });
  });
});
