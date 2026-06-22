import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '../src/tools/encode-base64.js';
import type { EncodeBase64Result } from '../src/tools/encode-base64.js';

describe('encodeBase64', () => {
  it('has the correct FunctionDefinition shape', () => {
    expect(encodeBase64.name).toBe('encodeBase64');
    expect(encodeBase64.riskTier).toBe('read');
    expect(encodeBase64.parameters.properties.text?.type).toBe('string');
    expect(encodeBase64.parameters.required).toEqual(['text']);
    expect(encodeBase64.parameters.additionalProperties).toBe(false);
  });

  it('encodes ASCII text', () => {
    expect((encodeBase64.handler({ text: 'hello' }) as EncodeBase64Result).base64).toBe('aGVsbG8=');
  });

  it('encodes the empty string', () => {
    expect((encodeBase64.handler({ text: '' }) as EncodeBase64Result).base64).toBe('');
  });

  it('is UTF-8 safe for unicode', () => {
    expect((encodeBase64.handler({ text: 'é' }) as EncodeBase64Result).base64).toBe('w6k=');
  });
});
