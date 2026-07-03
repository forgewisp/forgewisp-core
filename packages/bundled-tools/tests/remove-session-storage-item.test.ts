// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { removeSessionStorageItem } from '../src/tools/remove-session-storage-item.js';
import type { RemoveSessionStorageItemResult } from '../src/tools/remove-session-storage-item.js';

describe('removeSessionStorageItem', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(removeSessionStorageItem.name).toBe('removeSessionStorageItem');
    expect(removeSessionStorageItem.riskTier).toBe('destructive');
    expect(removeSessionStorageItem.parameters.required).toEqual(['key']);
    expect(removeSessionStorageItem.parameters.additionalProperties).toBe(false);
  });

  it('removes an existing key and reports existed: true', () => {
    sessionStorage.setItem('doomed', 'x');
    const result = removeSessionStorageItem.handler({
      key: 'doomed',
    }) as RemoveSessionStorageItemResult;
    expect(result).toEqual({ key: 'doomed', existed: true, removed: true });
    expect(sessionStorage.getItem('doomed')).toBeNull();
  });

  it('reports existed: false for an absent key', () => {
    const result = removeSessionStorageItem.handler({
      key: 'ghost',
    }) as RemoveSessionStorageItemResult;
    expect(result).toEqual({ key: 'ghost', existed: false, removed: true });
  });

  it('throws when sessionStorage is unavailable', () => {
    const original = globalThis.sessionStorage;
    Object.defineProperty(globalThis, 'sessionStorage', { value: undefined, configurable: true });
    try {
      expect(() => removeSessionStorageItem.handler({ key: 'k' })).toThrow(
        /sessionStorage is unavailable/,
      );
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { value: original, configurable: true });
    }
  });
});
