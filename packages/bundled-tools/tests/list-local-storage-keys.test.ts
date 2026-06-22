// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { listLocalStorageKeys } from '../src/tools/list-local-storage-keys.js';
import type { ListLocalStorageKeysResult } from '../src/tools/list-local-storage-keys.js';

describe('listLocalStorageKeys', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(listLocalStorageKeys.name).toBe('listLocalStorageKeys');
    expect(listLocalStorageKeys.riskTier).toBe('read');
    expect(listLocalStorageKeys.parameters.additionalProperties).toBe(false);
  });

  it('lists keys currently in storage', () => {
    localStorage.setItem('a', '1');
    localStorage.setItem('b', '2');
    const result = listLocalStorageKeys.handler({}) as ListLocalStorageKeysResult;
    expect(result.keys.sort()).toEqual(['a', 'b']);
  });

  it('returns an empty array when storage is empty', () => {
    const result = listLocalStorageKeys.handler({}) as ListLocalStorageKeysResult;
    expect(result.keys).toEqual([]);
  });

  it('throws when localStorage is unavailable', () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    try {
      expect(() => listLocalStorageKeys.handler({})).toThrow(/localStorage is unavailable/);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
    }
  });
});
