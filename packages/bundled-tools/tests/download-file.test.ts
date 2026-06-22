// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { downloadFile } from '../src/tools/download-file.js';
import type { DownloadFileResult } from '../src/tools/download-file.js';

describe('downloadFile', () => {
  let createObjectURL: Mock<[Blob], string>;
  let revokeObjectURL: Mock<[string], void>;
  let clickSpy: Mock<[], void>;

  beforeEach(() => {
    createObjectURL = vi.fn<[Blob], string>().mockReturnValue('blob:fake');
    revokeObjectURL = vi.fn<[string], void>();
    // jsdom does not implement URL.createObjectURL.
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
    // jsdom's HTMLElement.click is a no-op; spy to assert it was called.
    clickSpy = vi.fn<[], void>();
    Object.defineProperty(HTMLElement.prototype, 'click', { value: clickSpy, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(downloadFile.name).toBe('downloadFile');
    expect(downloadFile.riskTier).toBe('write');
    expect(downloadFile.parameters.required).toEqual(['filename', 'content']);
    expect(downloadFile.parameters.additionalProperties).toBe(false);
  });

  it('triggers a download and revokes the object URL', () => {
    const result = downloadFile.handler({
      filename: 'hello.txt',
      content: 'hi',
    }) as DownloadFileResult;
    expect(result).toEqual({ downloaded: true, filename: 'hello.txt', sizeBytes: 2 });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    // The anchor should be removed from the body after the click.
    expect(document.body.querySelector('a')).toBeNull();
  });

  it('rejects filenames containing path separators', () => {
    expect(() => downloadFile.handler({ filename: 'a/b.txt', content: 'x' })).toThrow(
      /path separators/,
    );
    expect(() => downloadFile.handler({ filename: 'a\\b.txt', content: 'x' })).toThrow(
      /path separators/,
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
