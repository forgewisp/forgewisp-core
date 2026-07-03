// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { getSessionStorageItem } from '../src/tools/get-session-storage-item.js';
import type { GetSessionStorageItemResult } from '../src/tools/get-session-storage-item.js';

describe('getSessionStorageItem', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(getSessionStorageItem.name).toBe('getSessionStorageItem');
    expect(getSessionStorageItem.riskTier).toBe('read');
    expect(getSessionStorageItem.parameters.required).toEqual(['key']);
    expect(getSessionStorageItem.parameters.additionalProperties).toBe(false);
  });

  it('returns the stored value when present', () => {
    sessionStorage.setItem('token', 'abc');
    const result = getSessionStorageItem.handler({ key: 'token' }) as GetSessionStorageItemResult;
    expect(result).toEqual({ key: 'token', value: 'abc', exists: true });
  });

  it('returns exists: false when absent', () => {
    const result = getSessionStorageItem.handler({ key: 'nope' }) as GetSessionStorageItemResult;
    expect(result).toEqual({ key: 'nope', value: null, exists: false });
  });

  it('throws when sessionStorage is unavailable', () => {
    const original = globalThis.sessionStorage;
    Object.defineProperty(globalThis, 'sessionStorage', { value: undefined, configurable: true });
    try {
      expect(() => getSessionStorageItem.handler({ key: 'k' })).toThrow(
        /sessionStorage is unavailable/,
      );
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { value: original, configurable: true });
    }
  });
});
