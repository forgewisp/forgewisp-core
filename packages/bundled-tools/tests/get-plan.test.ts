// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { getPlan } from '../src/tools/get-plan.js';
import type { GetPlanResult } from '../src/tools/get-plan.js';
import { createPlan } from '../src/tools/create-plan.js';
import type { CreatePlanResult } from '../src/tools/create-plan.js';

describe('getPlan', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(getPlan.name).toBe('getPlan');
    expect(getPlan.riskTier).toBe('read');
    expect(typeof getPlan.handler).toBe('function');

    const { parameters } = getPlan;
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['planId']);
    expect(parameters.additionalProperties).toBe(false);
    expect(parameters.properties.planId?.type).toBe('string');
    expect(parameters.properties.planId?.maxLength).toBe(100);
  });

  it('returns the full plan with items', () => {
    const created = createPlan.handler({
      title: 'Launch',
      items: [{ title: 'A' }, { title: 'B' }],
    }) as CreatePlanResult;

    const result = getPlan.handler({ planId: created.plan.id }) as GetPlanResult;
    expect(result.plan.id).toBe(created.plan.id);
    expect(result.plan.title).toBe('Launch');
    expect(result.plan.items.map((i) => i.title)).toEqual(['A', 'B']);
  });

  it('throws on an unknown plan id', () => {
    expect(() => getPlan.handler({ planId: 'nope' })).toThrow(/No plan with id "nope"/);
  });
});
