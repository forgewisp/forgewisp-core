import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface DownloadFileArgs {
  /** Suggested filename. Must not contain path separators. */
  filename: string;
  /** File contents as a UTF-8 string. */
  content: string;
  /** MIME type. Defaults to text/plain. */
  mimeType?: string;
}

export interface DownloadFileResult {
  downloaded: true;
  /** The filename that was downloaded. */
  filename: string;
  /** Size of the downloaded content in bytes. */
  sizeBytes: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    filename: {
      type: 'string',
      description: 'Suggested filename. Must not contain path separators (/ or \\).',
      minLength: 1,
      maxLength: 255,
    },
    content: {
      type: 'string',
      description: 'File contents as a UTF-8 string.',
      minLength: 0,
      maxLength: 10_000_000,
    },
    mimeType: {
      type: 'string',
      description: 'MIME type of the file. Defaults to text/plain.',
      minLength: 5,
      maxLength: 100,
    },
  },
  required: ['filename', 'content'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const downloadFile: FunctionDefinition<DownloadFileArgs> = defineTool({
  name: 'downloadFile',
  description:
    'Trigger a browser file download with the given filename and text content. Saves to the ' +
    "user's default downloads folder. Rejects filenames that contain path separators.",
  riskTier: 'write',
  parameters,
  handler: (args: DownloadFileArgs): DownloadFileResult => {
    if (/[\\/]/.test(args.filename)) {
      throw new Error('filename must not contain path separators (/ or \\).');
    }
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
      throw new Error('Download APIs unavailable (require a browser with URL.createObjectURL).');
    }
    const blob = new Blob([args.content], { type: args.mimeType ?? 'text/plain' });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = args.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
    return { downloaded: true, filename: args.filename, sizeBytes: blob.size };
  },
});
