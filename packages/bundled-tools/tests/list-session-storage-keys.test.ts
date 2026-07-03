// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { listSessionStorageKeys } from '../src/tools/list-session-storage-keys.js';
import type { ListSessionStorageKeysResult } from '../src/tools/list-session-storage-keys.js';

describe('listSessionStorageKeys', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(listSessionStorageKeys.name).toBe('listSessionStorageKeys');
    expect(listSessionStorageKeys.riskTier).toBe('read');
    expect(listSessionStorageKeys.parameters.type).toBe('object');
    expect(listSessionStorageKeys.parameters.required).toEqual([]);
    expect(listSessionStorageKeys.parameters.additionalProperties).toBe(false);
  });

  it('lists the keys in sessionStorage', () => {
    sessionStorage.setItem('a', '1');
    sessionStorage.setItem('b', '2');
    const result = listSessionStorageKeys.handler({}) as ListSessionStorageKeysResult;
    expect(result.keys.sort()).toEqual(['a', 'b']);
  });

  it('returns an empty array when sessionStorage is empty', () => {
    expect((listSessionStorageKeys.handler({}) as ListSessionStorageKeysResult).keys).toEqual([]);
  });

  it('throws when sessionStorage is unavailable', () => {
    const original = globalThis.sessionStorage;
    Object.defineProperty(globalThis, 'sessionStorage', { value: undefined, configurable: true });
    try {
      expect(() => listSessionStorageKeys.handler({})).toThrow(/sessionStorage is unavailable/);
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { value: original, configurable: true });
    }
  });
});
