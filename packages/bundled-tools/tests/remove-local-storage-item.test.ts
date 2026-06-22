// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { removeLocalStorageItem } from '../src/tools/remove-local-storage-item.js';
import type { RemoveLocalStorageItemResult } from '../src/tools/remove-local-storage-item.js';

describe('removeLocalStorageItem', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(removeLocalStorageItem.name).toBe('removeLocalStorageItem');
    expect(removeLocalStorageItem.riskTier).toBe('destructive');
    expect(removeLocalStorageItem.parameters.properties.key?.type).toBe('string');
    expect(removeLocalStorageItem.parameters.required).toEqual(['key']);
    expect(removeLocalStorageItem.parameters.additionalProperties).toBe(false);
  });

  it('removes an existing key and reports existed:true', () => {
    localStorage.setItem('k', 'v');
    const result = removeLocalStorageItem.handler({ key: 'k' }) as RemoveLocalStorageItemResult;
    expect(result).toEqual({ key: 'k', existed: true, removed: true });
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('reports existed:false for an absent key', () => {
    const result = removeLocalStorageItem.handler({
      key: 'missing',
    }) as RemoveLocalStorageItemResult;
    expect(result).toEqual({ key: 'missing', existed: false, removed: true });
  });

  it('throws when localStorage is unavailable', () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    try {
      expect(() => removeLocalStorageItem.handler({ key: 'k' })).toThrow(
        /localStorage is unavailable/,
      );
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
    }
  });
});
