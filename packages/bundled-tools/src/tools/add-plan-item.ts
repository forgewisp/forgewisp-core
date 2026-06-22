import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

import {
  addPlanItem as addPlanItemStore,
  type PlanItem,
  type PlanPriority,
} from '../plan-store.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface AddPlanItemArgs {
  /** The id of the plan to add the item to (obtain it from listPlans). */
  planId: string;
  /** Title of the new item, e.g. "Book flight". */
  title: string;
  /** Optional priority. */
  priority?: PlanPriority;
  /** Optional longer notes describing the item. */
  notes?: string;
}

export interface AddPlanItemResult {
  /** The created item, with its generated id and starting status "todo". */
  item: PlanItem;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    planId: {
      type: 'string',
      description: 'The id of the plan to add the item to. Use listPlans to find plan ids.',
      minLength: 1,
      maxLength: 100,
    },
    title: {
      type: 'string',
      description: 'A short title for the new item.',
      minLength: 1,
      maxLength: 200,
    },
    priority: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Optional priority for the new item.',
    },
    notes: {
      type: 'string',
      description: 'Optional longer notes describing the item.',
      minLength: 0,
      maxLength: 2000,
    },
  },
  required: ['planId', 'title'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const addPlanItem: FunctionDefinition<AddPlanItemArgs> = defineTool({
  name: 'addPlanItem',
  description:
    'Add a step to a plan you are tracking. Use this to break a task into concrete steps before ' +
    'starting work. The step starts with status "todo". Throws if the plan does not exist or is ' +
    'full (max 200 items). Use listPlans to find the plan id.',
  // read-tier: agent-owned scratchpad — see plan-store.ts header.
  riskTier: 'read',
  parameters,
  handler: (args: AddPlanItemArgs): AddPlanItemResult => {
    const item = addPlanItemStore(args.planId, {
      title: args.title,
      ...(args.priority !== undefined && { priority: args.priority }),
      ...(args.notes !== undefined && { notes: args.notes }),
    });
    return { item };
  },
});
