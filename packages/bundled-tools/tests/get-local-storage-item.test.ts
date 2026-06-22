// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { getLocalStorageItem } from '../src/tools/get-local-storage-item.js';
import type { GetLocalStorageItemResult } from '../src/tools/get-local-storage-item.js';

describe('getLocalStorageItem', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(getLocalStorageItem.name).toBe('getLocalStorageItem');
    expect(getLocalStorageItem.riskTier).toBe('read');
    expect(getLocalStorageItem.parameters.properties.key?.type).toBe('string');
    expect(getLocalStorageItem.parameters.required).toEqual(['key']);
    expect(getLocalStorageItem.parameters.additionalProperties).toBe(false);
  });

  it('returns the value when the key exists', () => {
    localStorage.setItem('name', 'Angelo');
    const result = getLocalStorageItem.handler({ key: 'name' }) as GetLocalStorageItemResult;
    expect(result).toEqual({ key: 'name', value: 'Angelo', exists: true });
  });

  it('returns exists:false when the key is absent', () => {
    const result = getLocalStorageItem.handler({ key: 'missing' }) as GetLocalStorageItemResult;
    expect(result).toEqual({ key: 'missing', value: null, exists: false });
  });
});
