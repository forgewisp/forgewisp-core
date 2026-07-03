// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { requestWakeLock } from '../src/tools/request-wake-lock.js';
import type { RequestWakeLockResult } from '../src/tools/request-wake-lock.js';

describe('requestWakeLock', () => {
  let request: Mock;

  afterEach(() => {
    // Release any sentinels held by prior tests so the module-level set doesn't
    // leak across tests, then reset state.
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    delete (navigator as { wakeLock?: unknown }).wakeLock;
  });

  function setWakeLock(sentinel?: Partial<{ release: Mock; released: boolean }>): {
    release: Mock;
  } {
    const release = vi.fn().mockResolvedValue(undefined);
    request = vi.fn().mockResolvedValue({ release, ...sentinel });
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    return { release };
  }

  it('has the correct FunctionDefinition shape', () => {
    expect(requestWakeLock.name).toBe('requestWakeLock');
    expect(requestWakeLock.riskTier).toBe('write');
    expect(requestWakeLock.parameters.required).toEqual([]);
    expect(requestWakeLock.parameters.additionalProperties).toBe(false);
    expect(requestWakeLock.parameters.properties.type?.enum).toEqual(['screen']);
  });

  it('acquires a screen wake lock and returns a serializable result', async () => {
    setWakeLock();
    const result = (await requestWakeLock.handler({ type: 'screen' })) as RequestWakeLockResult;
    expect(result).toEqual({ acquired: true, type: 'screen' });
    expect(request).toHaveBeenCalledWith('screen');
  });

  it('defaults to screen when type is omitted', async () => {
    setWakeLock();
    const result = (await requestWakeLock.handler({})) as RequestWakeLockResult;
    expect(result.type).toBe('screen');
    expect(request).toHaveBeenCalledWith('screen');
  });

  it('reports acquired:false when the sentinel is already released (tab hidden during await)', async () => {
    setWakeLock({ released: true });
    const result = (await requestWakeLock.handler({})) as RequestWakeLockResult;
    expect(result).toEqual({ acquired: false, type: 'screen' });
  });

  it('does not release a previous caller’s lock when a second call arrives', async () => {
    const first = setWakeLock();
    await requestWakeLock.handler({});
    expect(first.release).not.toHaveBeenCalled();

    // A second call gets its own sentinel; the first must stay held.
    const second = setWakeLock();
    await requestWakeLock.handler({});
    expect(first.release).not.toHaveBeenCalled();
    expect(second.release).not.toHaveBeenCalled();
  });

  it('throws when the Wake Lock API is unavailable', async () => {
    delete (navigator as { wakeLock?: unknown }).wakeLock;
    await expect(requestWakeLock.handler({})).rejects.toThrow(/Screen Wake Lock API unavailable/);
  });

  it('wraps acquisition failures with a clear message', async () => {
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: vi.fn().mockRejectedValue(new Error('not allowed')) },
      configurable: true,
    });
    await expect(requestWakeLock.handler({})).rejects.toThrow(/Failed to acquire wake lock/);
  });

  it('releases all held sentinels on visibilitychange to hidden', async () => {
    const first = setWakeLock();
    await requestWakeLock.handler({});
    expect(first.release).not.toHaveBeenCalled();

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    // The release call is fire-and-forget (void sentinel.release().catch(...)).
    await Promise.resolve();
    await Promise.resolve();
    expect(first.release).toHaveBeenCalled();
  });
});
