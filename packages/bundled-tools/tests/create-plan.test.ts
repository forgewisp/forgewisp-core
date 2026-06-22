// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { createPlan } from '../src/tools/create-plan.js';
import type { CreatePlanResult } from '../src/tools/create-plan.js';

describe('createPlan', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(createPlan.name).toBe('createPlan');
    expect(createPlan.riskTier).toBe('read');
    expect(typeof createPlan.handler).toBe('function');

    const { parameters } = createPlan;
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['title']);
    expect(parameters.additionalProperties).toBe(false);

    const title = parameters.properties.title;
    expect(title?.type).toBe('string');
    expect(title?.minLength).toBe(1);
    expect(title?.maxLength).toBe(200);

    const items = parameters.properties.items;
    expect(items?.type).toBe('array');
    expect(items?.maxItems).toBe(50);
    // The element object schema rejects extra properties.
    expect(items?.items?.additionalProperties).toBe(false);
    expect(items?.items?.required).toEqual(['title']);
  });

  it('creates a plan with seeded items', () => {
    const result = createPlan.handler({
      title: 'Weekend trip',
      items: [{ title: 'Book flight', priority: 'high' }, { title: 'Pack bags' }],
    }) as CreatePlanResult;

    expect(result.plan.title).toBe('Weekend trip');
    expect(result.plan.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.plan.items).toHaveLength(2);
    expect(result.plan.items[0]).toMatchObject({ title: 'Book flight', priority: 'high' });
  });

  it('creates an empty plan when items are omitted', () => {
    const result = createPlan.handler({ title: 'Empty plan' }) as CreatePlanResult;
    expect(result.plan.items).toEqual([]);
  });
});
