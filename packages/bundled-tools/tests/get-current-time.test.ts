import { describe, expect, it } from 'vitest';

import { getCurrentTime } from '../src/tools/get-current-time.js';
import type { GetCurrentTimeResult } from '../src/tools/get-current-time.js';

describe('getCurrentTime', () => {
  it('has the correct FunctionDefinition shape', () => {
    expect(getCurrentTime.name).toBe('getCurrentTime');
    expect(getCurrentTime.riskTier).toBe('read');
    expect(typeof getCurrentTime.handler).toBe('function');

    const { parameters } = getCurrentTime;
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual([]);
    expect(parameters.additionalProperties).toBe(false);

    const tz = parameters.properties.timezone;
    expect(tz).toBeDefined();
    expect(tz?.type).toBe('string');
    expect(typeof tz?.description).toBe('string');
    expect(tz?.minLength).toBe(1);
    expect(tz?.maxLength).toBe(100);
  });

  it('returns a full result object with a parseable ISO string by default', () => {
    const result = getCurrentTime.handler({}) as GetCurrentTimeResult;

    expect(new Date(result.iso).getTime()).not.toBeNaN();
    expect(result.timezone.length).toBeGreaterThan(0);
    expect(Number.isInteger(result.offsetMinutes)).toBe(true);
    expect(result.offsetMinutes).toBeGreaterThanOrEqual(-840);
    expect(result.offsetMinutes).toBeLessThanOrEqual(840);
    expect(typeof result.local).toBe('string');
    expect(result.local.length).toBeGreaterThan(0);
  });

  it('respects the timezone argument and computes the correct offset', () => {
    const ny = getCurrentTime.handler({ timezone: 'America/New_York' }) as GetCurrentTimeResult;
    expect(ny.timezone).toBe('America/New_York');
    // EST = -300, EDT = -240; accept either depending on the instant.
    expect([-300, -240]).toContain(ny.offsetMinutes);

    const ist = getCurrentTime.handler({ timezone: 'Asia/Kolkata' }) as GetCurrentTimeResult;
    expect(ist.timezone).toBe('Asia/Kolkata');
    expect(ist.offsetMinutes).toBe(330); // IST is UTC+5:30
  });

  it('throws on an invalid IANA timezone', () => {
    expect(() => getCurrentTime.handler({ timezone: 'Not/A_Real_Zone' })).toThrow(
      /Invalid timezone/,
    );
  });
});
