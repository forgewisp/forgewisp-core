// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { getGeolocation } from '../src/tools/get-geolocation.js';
import type { GetGeolocationResult } from '../src/tools/get-geolocation.js';

type SuccessCallback = (pos: {
  coords: { latitude: number; longitude: number; accuracy: number };
  timestamp: number;
}) => void;
type ErrorCallback = (err: { code: number; message: string }) => void;

describe('getGeolocation', () => {
  let getCurrentPosition: Mock<[SuccessCallback, ErrorCallback], void>;

  afterEach(() => {
    delete (navigator as { geolocation?: unknown }).geolocation;
    vi.useRealTimers();
  });

  function setGeolocation(impl: (ok: SuccessCallback, err: ErrorCallback) => void): void {
    getCurrentPosition = vi.fn<[SuccessCallback, ErrorCallback], void>(impl);
    Object.defineProperty(navigator, 'geolocation', {
      value: { getCurrentPosition },
      configurable: true,
    });
  }

  it('has the correct FunctionDefinition shape', () => {
    expect(getGeolocation.name).toBe('getGeolocation');
    expect(getGeolocation.riskTier).toBe('write');
    expect(getGeolocation.parameters.required).toEqual([]);
    expect(getGeolocation.parameters.additionalProperties).toBe(false);
  });

  it('resolves with coordinates on success', async () => {
    setGeolocation((ok) =>
      ok({
        coords: { latitude: 1, longitude: 2, accuracy: 3 },
        timestamp: 123,
      }),
    );
    const result = (await getGeolocation.handler({})) as GetGeolocationResult;
    expect(result).toEqual({ lat: 1, lng: 2, accuracy: 3, timestamp: 123 });
  });

  it('rejects with the geolocation error message on failure', async () => {
    setGeolocation((_ok, err) => err({ code: 1, message: 'denied' }));
    await expect(getGeolocation.handler({})).rejects.toThrow(/Geolocation error: denied/);
  });

  it('times out when no fix arrives', async () => {
    vi.useFakeTimers();
    setGeolocation(() => {
      /* never calls back */
    });
    const promise = getGeolocation.handler({ timeoutMs: 1000 });
    vi.advanceTimersByTime(2100);
    await expect(promise).rejects.toThrow(/Geolocation timed out/);
  });

  it('rejects when the API is unavailable', async () => {
    delete (navigator as { geolocation?: unknown }).geolocation;
    await expect(getGeolocation.handler({})).rejects.toThrow(/Geolocation API unavailable/);
  });
});
