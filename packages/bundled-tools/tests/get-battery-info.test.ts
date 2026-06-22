// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { getBatteryInfo } from '../src/tools/get-battery-info.js';
import type { GetBatteryInfoResult } from '../src/tools/get-battery-info.js';

describe('getBatteryInfo', () => {
  let original: unknown;

  afterEach(() => {
    if (original !== undefined) {
      Object.defineProperty(navigator, 'getBattery', { value: original, configurable: true });
    } else {
      delete (navigator as { getBattery?: unknown }).getBattery;
    }
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(getBatteryInfo.name).toBe('getBatteryInfo');
    expect(getBatteryInfo.riskTier).toBe('read');
    expect(getBatteryInfo.parameters.additionalProperties).toBe(false);
  });

  it('returns { supported: false } when the Battery API is absent', async () => {
    const result = (await getBatteryInfo.handler({})) as GetBatteryInfoResult;
    expect(result.supported).toBe(false);
  });

  it('returns battery fields when the API is present', async () => {
    original = (navigator as { getBattery?: unknown }).getBattery;
    Object.defineProperty(navigator, 'getBattery', {
      value: () =>
        Promise.resolve({
          charging: true,
          level: 0.5,
          chargingTime: 100,
          dischargingTime: 3600,
        }),
      configurable: true,
    });
    const result = (await getBatteryInfo.handler({})) as GetBatteryInfoResult;
    expect(result).toEqual({
      supported: true,
      charging: true,
      level: 0.5,
      chargingTime: 100,
      dischargingTime: 3600,
    });
  });
});
