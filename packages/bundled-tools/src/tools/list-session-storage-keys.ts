import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- no-arg tool
export interface ListSessionStorageKeysArgs {}

export interface ListSessionStorageKeysResult {
  /** The keys currently stored in sessionStorage. */
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
  const storage = globalThis.sessionStorage;
  if (!storage) {
    throw new Error('sessionStorage is unavailable in this environment.');
  }
  return storage;
}

export const listSessionStorageKeys: FunctionDefinition<ListSessionStorageKeysArgs> = defineTool({
  name: 'listSessionStorageKeys',
  description:
    "List the keys currently stored in this tab's sessionStorage. " +
    'sessionStorage is per-tab and cleared when the tab closes (unlike localStorage).',
  riskTier: 'read',
  parameters,
  handler: (): ListSessionStorageKeysResult => {
    return { keys: Object.keys(getStorage()) };
  },
});
