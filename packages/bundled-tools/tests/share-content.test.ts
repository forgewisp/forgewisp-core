// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { shareContent } from '../src/tools/share-content.js';
import type { ShareContentResult } from '../src/tools/share-content.js';

describe('shareContent', () => {
  let share: Mock;

  afterEach(() => {
    delete (navigator as { share?: unknown }).share;
    delete (navigator as { canShare?: unknown }).canShare;
  });

  function setShare(fn: Mock): void {
    share = fn;
    Object.defineProperty(navigator, 'share', { value: fn, configurable: true });
  }

  it('has the correct FunctionDefinition shape', () => {
    expect(shareContent.name).toBe('shareContent');
    expect(shareContent.riskTier).toBe('write');
    expect(shareContent.parameters.required).toEqual([]);
    expect(shareContent.parameters.additionalProperties).toBe(false);
    expect(shareContent.parameters.properties.text?.maxLength).toBe(5000);
    expect(shareContent.parameters.properties.url?.maxLength).toBe(2048);
  });

  it('shares and returns shared: true on success', async () => {
    setShare(vi.fn().mockResolvedValue(undefined));
    const result = (await shareContent.handler({
      title: 'Hi',
      text: 'Hello',
      url: 'https://example.com',
    })) as ShareContentResult;
    expect(result).toEqual({ shared: true });
    expect(share).toHaveBeenCalledWith({ title: 'Hi', text: 'Hello', url: 'https://example.com' });
  });

  it('reports cancelled when the user dismisses the sheet', async () => {
    setShare(vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError')));
    const result = (await shareContent.handler({ text: 'x' })) as ShareContentResult;
    expect(result).toEqual({ shared: false, reason: 'cancelled' });
  });

  it('throws on a non-AbortError share failure', async () => {
    setShare(vi.fn().mockRejectedValue(new Error('denied')));
    await expect(shareContent.handler({ text: 'x' })).rejects.toThrow(/Share failed/);
  });

  it('requires at least one of text or url', async () => {
    setShare(vi.fn().mockResolvedValue(undefined));
    await expect(shareContent.handler({ title: 'only title' })).rejects.toThrow(
      /at least one of text or url/,
    );
  });

  it('throws on an invalid url', async () => {
    setShare(vi.fn().mockResolvedValue(undefined));
    await expect(shareContent.handler({ url: 'not a url' })).rejects.toThrow(/Invalid url/);
  });

  it('throws when the Web Share API is unavailable', async () => {
    delete (navigator as { share?: unknown }).share;
    await expect(shareContent.handler({ text: 'x' })).rejects.toThrow(/Web Share API unavailable/);
  });
});
