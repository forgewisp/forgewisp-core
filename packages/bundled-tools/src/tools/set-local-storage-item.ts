import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface SetLocalStorageItemArgs {
  /** The localStorage key to set. */
  key: string;
  /** The string value to store. */
  value: string;
}

export interface SetLocalStorageItemResult {
  /** The key that was set. */
  key: string;
  /** The value that was stored. */
  value: string;
  /** Size of the stored value in UTF-8 bytes. */
  sizeBytes: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    key: {
      type: 'string',
      description: 'The localStorage key to set.',
      minLength: 1,
      maxLength: 1000,
    },
    value: {
      type: 'string',
      description: 'The string value to store.',
      minLength: 0,
      maxLength: 5_000_000,
    },
  },
  required: ['key', 'value'],
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

export const setLocalStorageItem: FunctionDefinition<SetLocalStorageItemArgs> = defineTool({
  name: 'setLocalStorageItem',
  description:
    'Store a string value in localStorage under the given key. Persists across page reloads. ' +
    'Throws if storage quota is exceeded.',
  riskTier: 'write',
  parameters,
  handler: (args: SetLocalStorageItemArgs): SetLocalStorageItemResult => {
    getStorage().setItem(args.key, args.value);
    return {
      key: args.key,
      value: args.value,
      sizeBytes: new TextEncoder().encode(args.value).length,
    };
  },
});
