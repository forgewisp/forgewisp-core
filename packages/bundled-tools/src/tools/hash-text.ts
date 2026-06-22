import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface HashTextArgs {
  /** UTF-8 text to hash. */
  text: string;
  /** Hash algorithm. Defaults to SHA-256. */
  algorithm?: 'SHA-256' | 'SHA-384' | 'SHA-512';
}

export interface HashTextResult {
  /** The algorithm that was used. */
  algorithm: string;
  /** The hexadecimal digest of the hash. */
  hex: string;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: 'UTF-8 text to hash.',
      minLength: 0,
      maxLength: 1_000_000,
    },
    algorithm: {
      type: 'string',
      enum: ['SHA-256', 'SHA-384', 'SHA-512'],
      description: 'Hash algorithm. Defaults to SHA-256.',
    },
  },
  required: ['text'],
  additionalProperties: false,
};

// ─── Tool definition ─────────────────────────────────────────────────────────

export const hashText: FunctionDefinition<HashTextArgs> = defineTool({
  name: 'hashText',
  description:
    'Hash UTF-8 text with SHA-256 (default), SHA-384, or SHA-512 and return the hex digest. ' +
    'Uses the Web Crypto API, so it requires a secure context (https or localhost).',
  riskTier: 'read',
  parameters,
  handler: async (args: HashTextArgs): Promise<HashTextResult> => {
    const cryptoObj = globalThis.crypto;
    if (!cryptoObj || typeof cryptoObj.subtle?.digest !== 'function') {
      throw new Error('crypto.subtle is unavailable (requires a secure context).');
    }
    const algorithm = args.algorithm ?? 'SHA-256';
    const data = new TextEncoder().encode(args.text);
    const digest = await cryptoObj.subtle.digest(algorithm, data);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (const b of bytes) {
      hex += b.toString(16).padStart(2, '0');
    }
    return { algorithm, hex };
  },
});
