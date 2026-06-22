import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface GetLocalStorageItemArgs {
  /** The localStorage key to read. */
  key: string;
}

export interface GetLocalStorageItemResult {
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
      description: 'The localStorage key to read.',
      minLength: 1,
      maxLength: 1000,
    },
  },
  required: ['key'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

function getStorage(): Storage {
  const storage = globalThis.localStorage;
  if (!storage) {
    throw new Error('localStorage is unavailable in this environment.');
  }
  return storage;
}

export const getLocalStorageItem: FunctionDefinition<GetLocalStorageItemArgs> = defineTool({
  name: 'getLocalStorageItem',
  description: 'Read a single value from localStorage by key. Returns { exists: false } if absent.',
  riskTier: 'read',
  parameters,
  handler: (args: GetLocalStorageItemArgs): GetLocalStorageItemResult => {
    const value = getStorage().getItem(args.key);
    return { key: args.key, value, exists: value !== null };
  },
});
