import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

import { getPlan as getPlanStore, type Plan } from '../plan-store.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface GetPlanArgs {
  /** The id of the plan to read (obtain it from listPlans). */
  planId: string;
}

export interface GetPlanResult {
  /** The full plan, including every item. */
  plan: Plan;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    planId: {
      type: 'string',
      description: 'The id of the plan to read. Use listPlans to find plan ids.',
      minLength: 1,
      maxLength: 100,
    },
  },
  required: ['planId'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const getPlan: FunctionDefinition<GetPlanArgs> = defineTool({
  name: 'getPlan',
  description:
    'Read a plan in full (all items with their ids, statuses, priorities, notes, and creation ' +
    'times) before editing it, so you act on current state rather than a stale snapshot. Use ' +
    'listPlans first to obtain the plan id. Throws if the plan does not exist.',
  riskTier: 'read',
  parameters,
  handler: (args: GetPlanArgs): GetPlanResult => {
    return { plan: getPlanStore(args.planId) };
  },
});
