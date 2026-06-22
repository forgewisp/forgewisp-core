import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

import { evaluateExpression } from '../eval-math.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface EvaluateMathArgs {
  /** Arithmetic expression using + - * / % ^, parentheses, decimals, and unary minus. */
  expression: string;
}

export interface EvaluateMathResult {
  /** The numeric result of the expression. */
  value: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    expression: {
      type: 'string',
      description:
        'Arithmetic expression supporting + - * / % ^, parentheses, decimals, and unary minus. ' +
        'No variables, functions, or other identifiers.',
      minLength: 1,
      maxLength: 200,
    },
  },
  required: ['expression'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const evaluateMath: FunctionDefinition<EvaluateMathArgs> = defineTool({
  name: 'evaluateMath',
  description:
    'Safely evaluate an arithmetic expression (+ - * / % ^, parentheses, decimals, unary minus). ' +
    'Use this rather than guessing or doing arithmetic by hand. Throws on invalid input or ' +
    'division/modulo by zero.',
  riskTier: 'read',
  parameters,
  handler: (args: EvaluateMathArgs): EvaluateMathResult => {
    return { value: evaluateExpression(args.expression) };
  },
});
