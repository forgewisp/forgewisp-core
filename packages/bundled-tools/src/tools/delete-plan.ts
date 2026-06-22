import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

import { deletePlan as deletePlanStore } from '../plan-store.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface DeletePlanArgs {
  /** The id of the plan to delete (obtain it from listPlans). */
  planId: string;
}

export interface DeletePlanResult {
  /** Whether the plan existed before deletion. */
  existed: boolean;
  removed: true;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    planId: {
      type: 'string',
      description: 'The id of the plan to delete. Use listPlans to find plan ids.',
      minLength: 1,
      maxLength: 100,
    },
  },
  required: ['planId'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const deletePlan: FunctionDefinition<DeletePlanArgs> = defineTool({
  name: 'deletePlan',
  description:
    'Delete a plan you finished with or abandoned. Call this to clean up your scratchpad once ' +
    'all steps are done or the task is no longer relevant. Use listPlans to find the plan id ' +
    'first. Prefer removePlanItem to prune individual steps rather than deleting the whole plan.',
  // read-tier: agent-owned scratchpad — see plan-store.ts header.
  riskTier: 'read',
  parameters,
  handler: (args: DeletePlanArgs): DeletePlanResult => {
    return deletePlanStore(args.planId);
  },
});
