import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

import { removePlanItem as removePlanItemStore } from '../plan-store.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface RemovePlanItemArgs {
  /** The id of the plan that contains the item. */
  planId: string;
  /** The id of the item to remove (obtain it from getPlan). */
  itemId: string;
}

export interface RemovePlanItemResult {
  /** Whether the item existed before removal. */
  existed: boolean;
  removed: true;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    planId: {
      type: 'string',
      description: 'The id of the plan that contains the item.',
      minLength: 1,
      maxLength: 100,
    },
    itemId: {
      type: 'string',
      description: 'The id of the item to remove. Use getPlan to find item ids.',
      minLength: 1,
      maxLength: 100,
    },
  },
  required: ['planId', 'itemId'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const removePlanItem: FunctionDefinition<RemovePlanItemArgs> = defineTool({
  name: 'removePlanItem',
  description:
    'Remove a step from your plan. Use this to drop steps that turned out to be unnecessary; ' +
    'prefer it over deleting the whole plan. Use getPlan to find the item id first. Throws if ' +
    'the plan does not exist.',
  // read-tier: agent-owned scratchpad — see plan-store.ts header.
  riskTier: 'read',
  parameters,
  handler: (args: RemovePlanItemArgs): RemovePlanItemResult => {
    return removePlanItemStore(args.planId, args.itemId);
  },
});
