import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface GetSessionStorageItemArgs {
  /** The sessionStorage key to read. */
  key: string;
}

export interface GetSessionStorageItemResult {
  /** The key that was read. */
  key: string;
  /** The stored value, or null if the key is absent. */
  value: string | null;
  /** Whether the key was present. */
  exists: boolean;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    key: {
      type: 'string',
      description: 'The sessionStorage key to read.',
      minLength: 1,
      maxLength: 1000,
    },
  },
  required: ['key'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

function getStorage(): Storage {
  const storage = globalThis.sessionStorage;
  if (!storage) {
    throw new Error('sessionStorage is unavailable in this environment.');
  }
  return storage;
}

export const getSessionStorageItem: FunctionDefinition<GetSessionStorageItemArgs> = defineTool({
  name: 'getSessionStorageItem',
  description:
    'Read a single value from sessionStorage by key. Returns { exists: false } if absent.',
  riskTier: 'read',
  parameters,
  handler: (args: GetSessionStorageItemArgs): GetSessionStorageItemResult => {
    const value = getStorage().getItem(args.key);
    return { key: args.key, value, exists: value !== null };
  },
});
