import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface EncodeBase64Args {
  /** UTF-8 text to encode. */
  text: string;
}

export interface EncodeBase64Result {
  /** The Base64-encoded string (UTF-8 safe). */
  base64: string;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'UTF-8 text to encode to Base64.',
      minLength: 0,
      maxLength: 1_000_000,
    },
  },
  required: ['text'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const encodeBase64: FunctionDefinition<EncodeBase64Args> = defineTool({
  name: 'encodeBase64',
  description: 'Encode UTF-8 text to a Base64 string. Safe for unicode characters.',
  riskTier: 'read',
  parameters,
  handler: (args: EncodeBase64Args): EncodeBase64Result => {
    if (typeof btoa !== 'function') {
      throw new Error('btoa is unavailable in this environment.');
    }
    const bytes = new TextEncoder().encode(args.text);
    let binary = '';
    for (const b of bytes) {
      binary += String.fromCharCode(b);
    }
    return { base64: btoa(binary) };
  },
});
