// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { clearLocalStorage } from '../src/tools/clear-local-storage.js';
import type { ClearLocalStorageResult } from '../src/tools/clear-local-storage.js';

describe('clearLocalStorage', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(clearLocalStorage.name).toBe('clearLocalStorage');
    expect(clearLocalStorage.riskTier).toBe('destructive');
    expect(clearLocalStorage.parameters.type).toBe('object');
    expect(clearLocalStorage.parameters.required).toEqual([]);
    expect(clearLocalStorage.parameters.additionalProperties).toBe(false);
  });

  it('removes all keys and reports the count', () => {
    localStorage.setItem('a', '1');
    localStorage.setItem('b', '2');
    localStorage.setItem('c', '3');
    const result = clearLocalStorage.handler({}) as ClearLocalStorageResult;
    expect(result.cleared).toBe(true);
    expect(result.keysRemoved).toBe(3);
    expect(localStorage.length).toBe(0);
  });

  it('reports zero keys when storage is already empty', () => {
    const result = clearLocalStorage.handler({}) as ClearLocalStorageResult;
    expect(result).toEqual({ keysRemoved: 0, cleared: true });
  });

  it('throws when localStorage is unavailable', () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true });
    try {
      expect(() => clearLocalStorage.handler({})).toThrow(/localStorage is unavailable/);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: original, configurable: true });
    }
  });
});
