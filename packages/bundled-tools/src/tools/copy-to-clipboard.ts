import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface CopyToClipboardArgs {
  /** Text to write to the clipboard. */
  text: string;
}

export interface CopyToClipboardResult {
  copied: true;
  /** Number of characters written. */
  length: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'Text to write to the clipboard.',
      minLength: 0,
      maxLength: 1_000_000,
    },
  },
  required: ['text'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const copyToClipboard: FunctionDefinition<CopyToClipboardArgs> = defineTool({
  name: 'copyToClipboard',
  description:
    "Write text to the user's clipboard. Requires a secure context (https or localhost) and " +
    'may require a user gesture / permission. Throws if the Clipboard API is unavailable or denied.',
  riskTier: 'write',
  parameters,
  handler: async (args: CopyToClipboardArgs): Promise<CopyToClipboardResult> => {
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      throw new Error('Clipboard API unavailable (requires a secure context).');
    }
    try {
      await clipboard.writeText(args.text);
    } catch (err) {
      throw new Error(
        'Clipboard write failed: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
    return { copied: true, length: args.text.length };
  },
});
