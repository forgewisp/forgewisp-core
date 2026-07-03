// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { setSessionStorageItem } from '../src/tools/set-session-storage-item.js';
import type { SetSessionStorageItemResult } from '../src/tools/set-session-storage-item.js';

describe('setSessionStorageItem', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(setSessionStorageItem.name).toBe('setSessionStorageItem');
    expect(setSessionStorageItem.riskTier).toBe('write');
    expect(setSessionStorageItem.parameters.required).toEqual(['key', 'value']);
    expect(setSessionStorageItem.parameters.additionalProperties).toBe(false);
  });

  it('stores the value and reports byte size', () => {
    const result = setSessionStorageItem.handler({
      key: 'name',
      value: 'Angelo',
    }) as SetSessionStorageItemResult;
    expect(result).toEqual({ key: 'name', value: 'Angelo', sizeBytes: 6 });
    expect(sessionStorage.getItem('name')).toBe('Angelo');
  });

  it('reports UTF-8 byte size for unicode', () => {
    const result = setSessionStorageItem.handler({
      key: 'k',
      value: 'é',
    }) as SetSessionStorageItemResult;
    expect(result.sizeBytes).toBe(2);
  });

  it('throws when sessionStorage is unavailable', () => {
    const original = globalThis.sessionStorage;
    Object.defineProperty(globalThis, 'sessionStorage', { value: undefined, configurable: true });
    try {
      expect(() => setSessionStorageItem.handler({ key: 'k', value: 'v' })).toThrow(
        /sessionStorage is unavailable/,
      );
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { value: original, configurable: true });
    }
  });
});
