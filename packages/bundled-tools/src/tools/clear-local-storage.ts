import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no-arg tool
export interface ClearLocalStorageArgs {}

export interface ClearLocalStorageResult {
  /** The number of keys that were removed. */
  keysRemoved: number;
  cleared: true;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {},
  required: [],
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

export const clearLocalStorage: FunctionDefinition<ClearLocalStorageArgs> = defineTool({
  name: 'clearLocalStorage',
  description:
    'Permanently remove ALL keys from this origin’s localStorage in one call. ' +
    'High blast radius — destroys every stored value for the origin, not just forgewisp keys. ' +
    'Destructive. Use only when the user explicitly asks to wipe all stored data.',
  riskTier: 'destructive',
  parameters,
  handler: (): ClearLocalStorageResult => {
    const storage = getStorage();
    const keysRemoved = Object.keys(storage).length;
    storage.clear();
    return { keysRemoved, cleared: true };
  },
});
