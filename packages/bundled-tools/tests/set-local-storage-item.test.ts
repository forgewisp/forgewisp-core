// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { setLocalStorageItem } from '../src/tools/set-local-storage-item.js';
import type { SetLocalStorageItemResult } from '../src/tools/set-local-storage-item.js';

describe('setLocalStorageItem', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(setLocalStorageItem.name).toBe('setLocalStorageItem');
    expect(setLocalStorageItem.riskTier).toBe('write');
    expect(setLocalStorageItem.parameters.required).toEqual(['key', 'value']);
    expect(setLocalStorageItem.parameters.additionalProperties).toBe(false);
  });

  it('stores the value and reports byte size', () => {
    const result = setLocalStorageItem.handler({
      key: 'name',
      value: 'Angelo',
    }) as SetLocalStorageItemResult;
    expect(result).toEqual({ key: 'name', value: 'Angelo', sizeBytes: 6 });
    expect(localStorage.getItem('name')).toBe('Angelo');
  });

  it('reports UTF-8 byte size for unicode', () => {
    const result = setLocalStorageItem.handler({
      key: 'k',
      value: 'é',
    }) as SetLocalStorageItemResult;
    // 'é' is two bytes in UTF-8 (0xC3 0xA9).
    expect(result.sizeBytes).toBe(2);
  });

  it('throws when localStorage is unavailable', () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    try {
      expect(() => setLocalStorageItem.handler({ key: 'k', value: 'v' })).toThrow(
        /localStorage is unavailable/,
      );
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
    }
  });
});
