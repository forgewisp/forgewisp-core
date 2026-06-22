import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface DecodeBase64Args {
  /** A Base64-encoded string. */
  base64: string;
}

export interface DecodeBase64Result {
  /** The decoded UTF-8 string. */
  text: string;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    base64: {
      type: 'string',
      description: 'A Base64-encoded string to decode to UTF-8 text.',
      minLength: 0,
      maxLength: 1_000_000,
    },
  },
  required: ['base64'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const decodeBase64: FunctionDefinition<DecodeBase64Args> = defineTool({
  name: 'decodeBase64',
  description: 'Decode a Base64 string back to UTF-8 text. Throws on invalid Base64 input.',
  riskTier: 'read',
  parameters,
  handler: (args: DecodeBase64Args): DecodeBase64Result => {
    if (typeof atob !== 'function') {
      throw new Error('atob is unavailable in this environment.');
    }
    let binary: string;
    try {
      binary = atob(args.base64);
    } catch {
      throw new Error('Invalid base64 input.');
    }
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return { text: new TextDecoder().decode(bytes) };
  },
});
