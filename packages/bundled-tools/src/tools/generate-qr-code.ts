import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';
import { encodeQR } from '../qr-encode.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface GenerateQrCodeArgs {
  /** The text/URL to encode. */
  text: string;
  /** Output image edge length in pixels. Defaults to 256. */
  size?: number;
  /** Error-correction level. Defaults to "M". */
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  /** Quiet-zone width in modules. Defaults to 4 (the QR spec minimum). */
  margin?: number;
}

export interface GenerateQrCodeResult {
  /** The QR matrix rendered as a PNG data URL. */
  dataUrl: string;
  /** Output image edge length in pixels. */
  size: number;
  /** Edge length of the QR matrix in modules (excluding quiet zone). */
  modules: number;
  /** Detected/selected QR version (1–10). */
  version: number;
  /** Error-correction level used. */
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H';
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'The text or URL to encode as a QR code (UTF-8).',
      minLength: 1,
      maxLength: 270,
    },
    size: {
      type: 'number',
      description: 'Output image edge length in pixels. Defaults to 256.',
      minimum: 64,
      maximum: 1024,
    },
    errorCorrectionLevel: {
      type: 'string',
      enum: ['L', 'M', 'Q', 'H'],
      description: 'Error-correction level. Defaults to "M".',
    },
    margin: {
      type: 'number',
      description: 'Quiet-zone width in modules. Defaults to 4 (the QR spec minimum).',
      minimum: 0,
      maximum: 20,
    },
  },
  required: ['text'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const generateQrCode: FunctionDefinition<GenerateQrCodeArgs> = defineTool({
  name: 'generateQrCode',
  description:
    'Generate a QR code from text or a URL and return it as a PNG data URL. ' +
    'Auto-selects the smallest version (1–10) that fits at the requested error-correction ' +
    'level. Requires a browser canvas (the renderer draws to an offscreen <canvas>). ' +
    'The PNG is large, so it is elided from the value relayed back to you and instead ' +
    'surfaced to the user as an image artifact via the audit log. The tool succeeds and ' +
    'the image is already shown to the user, so the elided payload does not need to be ' +
    'recovered.',
  riskTier: 'read',
  parameters,
  handler: (args: GenerateQrCodeArgs): GenerateQrCodeResult => {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      throw new Error('A browser DOM is required to render a QR code (canvas unavailable).');
    }
    const level = args.errorCorrectionLevel ?? 'M';
    const encoded = encodeQR(args.text, level);

    const margin = args.margin ?? 4;
    const requestedSize = args.size ?? 256;
    const modules = encoded.size;
    const modulesWithMargin = modules + margin * 2;
    // Each module must occupy at least one whole pixel, or fractional `fillRect`
    // widths make the canvas anti-alias dark/light modules into gray sub-pixels
    // that scanners refuse. Clamp the image up to the module-grid size when the
    // requested size is too small to hold every module.
    const pixelSize = Math.max(requestedSize, modulesWithMargin);
    const scale = pixelSize / modulesWithMargin;

    const canvas = document.createElement('canvas');
    canvas.width = pixelSize;
    canvas.height = pixelSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to acquire a 2D canvas context.');
    }
    // Light background.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pixelSize, pixelSize);
    // Dark modules, each rendered to integer pixel boundaries (no anti-aliasing).
    ctx.fillStyle = '#000000';
    for (let r = 0; r < modules; r++) {
      for (let c = 0; c < modules; c++) {
        if (encoded.matrix[r]![c]) {
          const x0 = Math.round((c + margin) * scale);
          const y0 = Math.round((r + margin) * scale);
          const w = Math.round((c + margin + 1) * scale) - x0;
          const h = Math.round((r + margin + 1) * scale) - y0;
          ctx.fillRect(x0, y0, w, h);
        }
      }
    }

    if (typeof canvas.toDataURL !== 'function') {
      throw new Error('canvas.toDataURL is unavailable in this environment.');
    }
    const dataUrl = canvas.toDataURL('image/png');

    return {
      dataUrl,
      size: pixelSize,
      modules,
      version: encoded.version,
      errorCorrectionLevel: level,
    };
  },
});
