import { describe, expect, it } from 'vitest';

import { PLANNING_TOOLS } from '../src/index.js';

describe('PLANNING_TOOLS', () => {
  it('is a named ToolSet', () => {
    expect(PLANNING_TOOLS.name).toBe('planning');
    expect(typeof PLANNING_TOOLS.description).toBe('string');
  });

  it('contains exactly the 7 plan tools in order, all read-tier', () => {
    expect(PLANNING_TOOLS.tools.map((t) => t.name)).toEqual([
      'listPlans',
      'getPlan',
      'createPlan',
      'addPlanItem',
      'updatePlanItem',
      'removePlanItem',
      'deletePlan',
    ]);
    expect(PLANNING_TOOLS.tools).toHaveLength(7);
    expect(PLANNING_TOOLS.tools.every((t) => t.riskTier === 'read')).toBe(true);
  });
});
