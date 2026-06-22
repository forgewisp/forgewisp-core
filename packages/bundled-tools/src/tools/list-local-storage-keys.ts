import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no-arg tool
export interface ListLocalStorageKeysArgs {}

export interface ListLocalStorageKeysResult {
  /** The keys currently stored in localStorage. */
  keys: string[];
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

export const listLocalStorageKeys: FunctionDefinition<ListLocalStorageKeysArgs> = defineTool({
  name: 'listLocalStorageKeys',
  description: "List the keys currently stored in this origin's localStorage.",
  riskTier: 'read',
  parameters,
  handler: (): ListLocalStorageKeysResult => {
    return { keys: Object.keys(getStorage()) };
  },
});
