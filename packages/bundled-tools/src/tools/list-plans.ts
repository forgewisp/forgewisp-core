import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

import { listPlans as listPlansStore, type PlanSummary } from '../plan-store.js';

// ─── Args & result ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no-arg tool
export interface ListPlansArgs {}

export interface ListPlansResult {
  /** Compact summaries of every stored plan. Empty array when none exist. */
  plans: PlanSummary[];
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const listPlans: FunctionDefinition<ListPlansArgs> = defineTool({
  name: 'listPlans',
  description:
    'List your plans as compact summaries (id, title, item counts by status, creation time) to ' +
    'see what you are currently tracking. Call this at the start of a turn if you may have an ' +
    'in-progress plan to resume, and before getPlan/addPlanItem/updatePlanItem/removePlanItem/' +
    'deletePlan to discover the plan id to operate on. Returns an empty array when none exist.',
  riskTier: 'read',
  parameters,
  handler: (): ListPlansResult => {
    return { plans: listPlansStore() };
  },
});
