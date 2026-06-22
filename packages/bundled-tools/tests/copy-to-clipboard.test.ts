// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { copyToClipboard } from '../src/tools/copy-to-clipboard.js';
import type { CopyToClipboardResult } from '../src/tools/copy-to-clipboard.js';

describe('copyToClipboard', () => {
  let writeText: Mock<[string], Promise<void>>;

  afterEach(() => {
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  function setClipboard(fn: Mock<[string], Promise<void>>): void {
    writeText = fn;
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  }

  it('has the correct FunctionDefinition shape', () => {
    expect(copyToClipboard.name).toBe('copyToClipboard');
    expect(copyToClipboard.riskTier).toBe('write');
    expect(copyToClipboard.parameters.properties.text?.type).toBe('string');
    expect(copyToClipboard.parameters.required).toEqual(['text']);
    expect(copyToClipboard.parameters.additionalProperties).toBe(false);
  });

  it('writes text to the clipboard', async () => {
    setClipboard(vi.fn<[string], Promise<void>>().mockResolvedValue(undefined));
    const result = (await copyToClipboard.handler({ text: 'hello' })) as CopyToClipboardResult;
    expect(result).toEqual({ copied: true, length: 5 });
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('throws when the Clipboard API is unavailable', async () => {
    // No clipboard stub set on navigator (deleted in afterEach, but ensure absent here).
    delete (navigator as { clipboard?: unknown }).clipboard;
    await expect(copyToClipboard.handler({ text: 'x' })).rejects.toThrow(
      /Clipboard API unavailable/,
    );
  });

  it('surfaces permission denial as an error', async () => {
    setClipboard(vi.fn<[string], Promise<void>>().mockRejectedValue(new Error('not allowed')));
    await expect(copyToClipboard.handler({ text: 'x' })).rejects.toThrow(/Clipboard write failed/);
  });
});
