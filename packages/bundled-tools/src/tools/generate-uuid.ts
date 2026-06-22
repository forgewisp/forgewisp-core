import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no-arg tool
export interface GenerateUuidArgs {}

export interface GenerateUuidResult {
  /** A RFC 4122 v4 UUID string, e.g. "3f250431-89f1-4d16-a3bf-72024f72a928". */
  uuid: string;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const generateUuid: FunctionDefinition<GenerateUuidArgs> = defineTool({
  name: 'generateUuid',
  description:
    'Generate a random RFC 4122 version 4 UUID. Useful when you need a unique identifier.',
  riskTier: 'read',
  parameters,
  handler: (): GenerateUuidResult => {
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
      throw new Error('crypto.randomUUID is unavailable in this environment.');
    }
    return { uuid: crypto.randomUUID() };
  },
});
