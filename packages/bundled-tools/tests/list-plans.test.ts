// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { listPlans } from '../src/tools/list-plans.js';
import type { ListPlansResult } from '../src/tools/list-plans.js';
import { createPlan } from '../src/tools/create-plan.js';

describe('listPlans', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(listPlans.name).toBe('listPlans');
    expect(listPlans.riskTier).toBe('read');
    expect(typeof listPlans.handler).toBe('function');

    const { parameters } = listPlans;
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual([]);
    expect(parameters.additionalProperties).toBe(false);
  });

  it('returns an empty array when no plans exist', () => {
    const result = listPlans.handler({}) as ListPlansResult;
    expect(result.plans).toEqual([]);
  });

  it('lists stored plans with item and done counts', () => {
    createPlan.handler({ title: 'A', items: [{ title: 'x' }, { title: 'y' }] });
    createPlan.handler({ title: 'B' });

    const result = listPlans.handler({}) as ListPlansResult;
    const titles = result.plans.map((p) => p.title).sort();
    expect(titles).toEqual(['A', 'B']);
    const a = result.plans.find((p) => p.title === 'A');
    expect(a).toMatchObject({ itemCount: 2, doneCount: 0 });
  });
});
