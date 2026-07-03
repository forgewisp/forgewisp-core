// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { vibrateDevice } from '../src/tools/vibrate-device.js';
import type { VibrateDeviceResult } from '../src/tools/vibrate-device.js';

describe('vibrateDevice', () => {
  let vibrate: Mock<[number | number[]], boolean>;

  afterEach(() => {
    delete (navigator as { vibrate?: unknown }).vibrate;
  });

  function setVibrate(fn: Mock<[number | number[]], boolean>): void {
    vibrate = fn;
    Object.defineProperty(navigator, 'vibrate', { value: fn, configurable: true });
  }

  it('has the correct FunctionDefinition shape', () => {
    expect(vibrateDevice.name).toBe('vibrateDevice');
    expect(vibrateDevice.riskTier).toBe('write');
    expect(vibrateDevice.parameters.required).toEqual(['pattern']);
    expect(vibrateDevice.parameters.additionalProperties).toBe(false);

    const pattern = vibrateDevice.parameters.properties.pattern;
    expect(pattern).toBeDefined();
    expect(pattern?.type).toBe('array');
    expect(pattern?.minItems).toBe(1);
    expect(pattern?.maxItems).toBe(50);
  });

  it('vibrates with the given pattern and reports vibrated: true', () => {
    setVibrate(vi.fn<[number | number[]], boolean>().mockReturnValue(true));
    const result = vibrateDevice.handler({ pattern: [200, 100, 200] }) as VibrateDeviceResult;
    expect(result).toEqual({ vibrated: true, pattern: [200, 100, 200] });
    expect(vibrate).toHaveBeenCalledWith([200, 100, 200]);
  });

  it('reports vibrated: false when the platform declines', () => {
    setVibrate(vi.fn<[number | number[]], boolean>().mockReturnValue(false));
    const result = vibrateDevice.handler({ pattern: [200] }) as VibrateDeviceResult;
    expect(result.vibrated).toBe(false);
  });

  it('throws when the Vibration API is unavailable', () => {
    delete (navigator as { vibrate?: unknown }).vibrate;
    expect(() => vibrateDevice.handler({ pattern: [200] })).toThrow(/Vibration API unavailable/);
  });
});
