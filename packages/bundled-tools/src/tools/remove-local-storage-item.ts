import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface RemoveLocalStorageItemArgs {
  /** The localStorage key to remove. */
  key: string;
}

export interface RemoveLocalStorageItemResult {
  /** The key that was removed. */
  key: string;
  /** Whether the key existed before removal. */
  existed: boolean;
  removed: true;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    key: {
      type: 'string',
      description: 'The localStorage key to remove.',
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

export const removeLocalStorageItem: FunctionDefinition<RemoveLocalStorageItemArgs> = defineTool({
  name: 'removeLocalStorageItem',
  description:
    'Permanently remove a key from localStorage. Destructive — the stored value is lost. ' +
    'Use when the user explicitly asks to forget/delete a stored value.',
  riskTier: 'destructive',
  parameters,
  handler: (args: RemoveLocalStorageItemArgs): RemoveLocalStorageItemResult => {
    const storage = getStorage();
    const existed = storage.getItem(args.key) !== null;
    storage.removeItem(args.key);
    return { key: args.key, existed, removed: true };
  },
});
