import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

import { createPlan as createPlanStore, type Plan, type PlanPriority } from '../plan-store.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface CreatePlanItemInput {
  /** Title of the item, e.g. "Book flight". */
  title: string;
  /** Optional priority. Defaults to unset (treated as normal). */
  priority?: PlanPriority;
}

export interface CreatePlanArgs {
  /** Name of the plan, e.g. "Weekend trip" or "Q3 launch". */
  title: string;
  /** Optional initial items to seed the plan with. */
  items?: CreatePlanItemInput[];
}

export interface CreatePlanResult {
  /** The created plan, including generated id and items. */
  plan: Plan;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'A short, human-readable name for the plan.',
      minLength: 1,
      maxLength: 200,
    },
    items: {
      type: 'array',
      description: 'Optional initial items to seed the plan with.',
      maxItems: 50,
      items: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Title of the item.',
            minLength: 1,
            maxLength: 200,
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'Optional priority for the item.',
          },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  required: ['title'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const createPlan: FunctionDefinition<CreatePlanArgs> = defineTool({
  name: 'createPlan',
  description:
    'Create a plan to track a multi-step task you are working on. Call this up front for any ' +
    'non-trivial request with 2+ steps, then add items for each step. The plan is your job ' +
    'scratchpad, persisted in localStorage under "forgewisp.plans" so you stay oriented across ' +
    'rounds. Returns the new plan with its generated id and items. Use listPlans to discover ' +
    'existing plans and getPlan to read one in full.',
  // read-tier: agent-owned scratchpad — see plan-store.ts header.
  riskTier: 'read',
  parameters,
  handler: (args: CreatePlanArgs): CreatePlanResult => {
    const plan = createPlanStore(args.title, args.items);
    return { plan };
  },
});
