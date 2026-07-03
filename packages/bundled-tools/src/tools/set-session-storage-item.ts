import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface SetSessionStorageItemArgs {
  /** The sessionStorage key to set. */
  key: string;
  /** The string value to store. */
  value: string;
}

export interface SetSessionStorageItemResult {
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
      description: 'The sessionStorage key to set.',
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
  const storage = globalThis.sessionStorage;
  if (!storage) {
    throw new Error('sessionStorage is unavailable in this environment.');
  }
  return storage;
}

export const setSessionStorageItem: FunctionDefinition<SetSessionStorageItemArgs> = defineTool({
  name: 'setSessionStorageItem',
  description:
    'Store a string value in sessionStorage under the given key. ' +
    'sessionStorage is per-tab and cleared when the tab closes (unlike localStorage). ' +
    'Throws if storage quota is exceeded.',
  riskTier: 'write',
  parameters,
  handler: (args: SetSessionStorageItemArgs): SetSessionStorageItemResult => {
    getStorage().setItem(args.key, args.value);
    return {
      key: args.key,
      value: args.value,
      sizeBytes: new TextEncoder().encode(args.value).length,
    };
  },
});
