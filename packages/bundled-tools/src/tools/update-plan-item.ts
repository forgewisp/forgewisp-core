import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

import {
  updatePlanItem as updatePlanItemStore,
  type PlanItem,
  type PlanPriority,
  type PlanStatus,
} from '../plan-store.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface UpdatePlanItemArgs {
  /** The id of the plan that contains the item. */
  planId: string;
  /** The id of the item to update (obtain it from getPlan). */
  itemId: string;
  /** New title. */
  title?: string;
  /** New status. */
  status?: PlanStatus;
  /** New priority. */
  priority?: PlanPriority;
  /** New notes. Pass an empty string to clear notes. */
  notes?: string;
}

export interface UpdatePlanItemResult {
  /** The updated item. */
  item: PlanItem;
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
      description: 'The id of the item to update. Use getPlan to find item ids.',
      minLength: 1,
      maxLength: 100,
    },
    title: {
      type: 'string',
      description: 'New title for the item.',
      minLength: 1,
      maxLength: 200,
    },
    status: {
      type: 'string',
      enum: ['todo', 'in_progress', 'done'],
      description: 'New status for the item.',
    },
    priority: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'New priority for the item.',
    },
    notes: {
      type: 'string',
      description: 'New notes for the item. Pass an empty string to clear notes.',
      minLength: 0,
      maxLength: 2000,
    },
  },
  required: ['planId', 'itemId'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const updatePlanItem: FunctionDefinition<UpdatePlanItemArgs> = defineTool({
  name: 'updatePlanItem',
  description:
    'Update a step in your plan: set status to "in_progress" when you start it and "done" when ' +
    'you complete it, and add notes about progress or findings. At least one optional field must ' +
    'be provided. Call getPlan first if you need the current item state, then mark progress, ' +
    'reprioritize, rename, or annotate. Throws if the plan or item does not exist.',
  // read-tier: agent-owned scratchpad — see plan-store.ts header.
  riskTier: 'read',
  parameters,
  handler: (args: UpdatePlanItemArgs): UpdatePlanItemResult => {
    const item = updatePlanItemStore(args.planId, args.itemId, {
      ...(args.title !== undefined && { title: args.title }),
      ...(args.status !== undefined && { status: args.status }),
      ...(args.priority !== undefined && { priority: args.priority }),
      ...(args.notes !== undefined && { notes: args.notes }),
    });
    return { item };
  },
});
