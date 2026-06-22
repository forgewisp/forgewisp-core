import { describe, expect, it } from 'vitest';

import { hashText } from '../src/tools/hash-text.js';
import type { HashTextResult } from '../src/tools/hash-text.js';

async function sha(algorithm: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest(algorithm, data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

describe('hashText', () => {
  it('has the correct FunctionDefinition shape', () => {
    expect(hashText.name).toBe('hashText');
    expect(hashText.riskTier).toBe('read');
    expect(typeof hashText.handler).toBe('function');
    expect(hashText.parameters.properties.text?.type).toBe('string');
    expect(hashText.parameters.properties.algorithm?.enum).toEqual([
      'SHA-256',
      'SHA-384',
      'SHA-512',
    ]);
    expect(hashText.parameters.required).toEqual(['text']);
    expect(hashText.parameters.additionalProperties).toBe(false);
  });

  it('hashes text with SHA-256 by default', async () => {
    const result = (await hashText.handler({ text: 'hello' })) as HashTextResult;
    expect(result.algorithm).toBe('SHA-256');
    expect(result.hex).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('hashes the empty string to the known SHA-256 vector', async () => {
    const result = (await hashText.handler({ text: '' })) as HashTextResult;
    expect(result.hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('supports SHA-512 and returns a 128-char hex digest', async () => {
    const result = (await hashText.handler({
      text: 'hello',
      algorithm: 'SHA-512',
    })) as HashTextResult;
    expect(result.algorithm).toBe('SHA-512');
    expect(result.hex).toHaveLength(128);
    expect(result.hex).toBe(await sha('SHA-512', 'hello'));
  });

  it('handles unicode (UTF-8) correctly', async () => {
    const result = (await hashText.handler({ text: 'é' })) as HashTextResult;
    expect(result.hex).toBe(await sha('SHA-256', 'é'));
  });

  it('throws when crypto.subtle is unavailable', async () => {
    const original = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
    try {
      await expect(hashText.handler({ text: 'x' })).rejects.toThrow(
        /crypto\.subtle is unavailable/,
      );
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});
