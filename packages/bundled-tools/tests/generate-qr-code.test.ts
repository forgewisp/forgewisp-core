// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { generateQrCode } from '../src/tools/generate-qr-code.js';
import type { GenerateQrCodeResult } from '../src/tools/generate-qr-code.js';

describe('generateQrCode', () => {
  let originalCreateElement: typeof document.createElement;
  let toDataURL: Mock;
  let fillRect: Mock;

  function installCanvasMock(getContextReturn: unknown): void {
    toDataURL = vi.fn().mockReturnValue('data:image/png;base64,FAKE');
    Object.defineProperty(document, 'createElement', {
      value: vi.fn((tag: string) => {
        if (tag !== 'canvas') return originalCreateElement(tag);
        return {
          width: 0,
          height: 0,
          getContext: () => getContextReturn,
          toDataURL,
        };
      }),
      configurable: true,
    });
  }

  /** Install a working 2D-context mock and return its `fillRect` spy. */
  function installCanvasWithCtx(): void {
    fillRect = vi.fn();
    installCanvasMock({ fillStyle: '', fillRect });
  }

  beforeEach(() => {
    originalCreateElement = document.createElement.bind(document);
  });

  afterEach(() => {
    Object.defineProperty(document, 'createElement', {
      value: originalCreateElement,
      configurable: true,
    });
  });

  it('has the correct FunctionDefinition shape', () => {
    expect(generateQrCode.name).toBe('generateQrCode');
    expect(generateQrCode.riskTier).toBe('read');
    expect(generateQrCode.parameters.required).toEqual(['text']);
    expect(generateQrCode.parameters.additionalProperties).toBe(false);
    expect(generateQrCode.parameters.properties.text?.maxLength).toBe(270);
    expect(generateQrCode.parameters.properties.errorCorrectionLevel?.enum).toEqual([
      'L',
      'M',
      'Q',
      'H',
    ]);
  });

  it('renders a QR code and returns a PNG data URL', async () => {
    installCanvasWithCtx();
    const result = (await generateQrCode.handler({
      text: 'HELLO WORLD', // 11 bytes → version 1 at level M (capacity 14)
      size: 200,
    })) as GenerateQrCodeResult;
    expect(result.dataUrl).toBe('data:image/png;base64,FAKE');
    expect(result.size).toBe(200);
    expect(result.version).toBe(1);
    expect(result.modules).toBe(21);
    expect(result.errorCorrectionLevel).toBe('M');
    expect(toDataURL).toHaveBeenCalledWith('image/png');
    // The background fill + at least one dark-module fill must have happened.
    expect(fillRect).toHaveBeenCalled();
  });

  it('honors the errorCorrectionLevel argument', async () => {
    installCanvasWithCtx();
    const result = (await generateQrCode.handler({
      text: 'hello',
      errorCorrectionLevel: 'H',
    })) as GenerateQrCodeResult;
    expect(result.errorCorrectionLevel).toBe('H');
  });

  it('defaults size to 256', async () => {
    installCanvasWithCtx();
    const result = (await generateQrCode.handler({ text: 'x' })) as GenerateQrCodeResult;
    expect(result.size).toBe(256);
  });

  it('clamps a too-small image up to the module grid so every module is ≥1px', async () => {
    installCanvasWithCtx();
    // 200 bytes forces version 10 at level M (57 modules); margin 4 → 65 grid.
    const result = (await generateQrCode.handler({
      text: 'a'.repeat(200),
      size: 64,
    })) as GenerateQrCodeResult;
    expect(result.version).toBe(10);
    expect(result.modules).toBe(57);
    // Requested 64 is below the 65-module grid → bumped to 65 (no sub-pixel modules).
    expect(result.size).toBe(65);
  });

  it('throws when the DOM is unavailable', () => {
    Object.defineProperty(document, 'createElement', { value: undefined, configurable: true });
    try {
      expect(() => generateQrCode.handler({ text: 'x' })).toThrow(/canvas unavailable/);
    } finally {
      Object.defineProperty(document, 'createElement', {
        value: originalCreateElement,
        configurable: true,
      });
    }
  });

  it('throws when no 2D context can be acquired', () => {
    installCanvasMock(null);
    expect(() => generateQrCode.handler({ text: 'x' })).toThrow(/2D canvas context/);
  });

  it('rejects input that is too long', () => {
    installCanvasWithCtx();
    expect(() => generateQrCode.handler({ text: 'a'.repeat(271) })).toThrow(/too long/);
  });
});
