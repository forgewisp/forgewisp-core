// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { getViewportInfo } from '../src/tools/get-viewport-info.js';
import type { GetViewportInfoResult } from '../src/tools/get-viewport-info.js';

describe('getViewportInfo', () => {
  it('has the correct FunctionDefinition shape', () => {
    expect(getViewportInfo.name).toBe('getViewportInfo');
    expect(getViewportInfo.riskTier).toBe('read');
    expect(getViewportInfo.parameters.required).toEqual([]);
    expect(getViewportInfo.parameters.additionalProperties).toBe(false);
  });

  it('returns the viewport/environment fields', () => {
    const result = getViewportInfo.handler({}) as GetViewportInfoResult;
    expect(typeof result.innerWidth).toBe('number');
    expect(typeof result.innerHeight).toBe('number');
    expect(typeof result.devicePixelRatio).toBe('number');
    expect(typeof result.screenWidth).toBe('number');
    expect(typeof result.screenHeight).toBe('number');
    expect(typeof result.userAgent).toBe('string');
    expect(typeof result.language).toBe('string');
    expect(typeof result.onLine).toBe('boolean');
    // jsdom's user agent contains "jsdom".
    expect(result.userAgent).toContain('jsdom');
  });

  it('throws when window is undefined', () => {
    const original = globalThis.window;
    // @ts-expect-error -- intentionally removing window
    globalThis.window = undefined;
    try {
      expect(() => getViewportInfo.handler({})).toThrow(/Not running in a browser/);
    } finally {
      globalThis.window = original;
    }
  });
});
