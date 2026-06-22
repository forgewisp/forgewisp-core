import { describe, expect, it } from 'vitest';

import { decodeBase64 } from '../src/tools/decode-base64.js';
import { encodeBase64 } from '../src/tools/encode-base64.js';
import type { DecodeBase64Result } from '../src/tools/decode-base64.js';

describe('decodeBase64', () => {
  it('has the correct FunctionDefinition shape', () => {
    expect(decodeBase64.name).toBe('decodeBase64');
    expect(decodeBase64.riskTier).toBe('read');
    expect(decodeBase64.parameters.properties.base64?.type).toBe('string');
    expect(decodeBase64.parameters.required).toEqual(['base64']);
    expect(decodeBase64.parameters.additionalProperties).toBe(false);
  });

  it('decodes ASCII text', () => {
    expect((decodeBase64.handler({ base64: 'aGVsbG8=' }) as DecodeBase64Result).text).toBe('hello');
  });

  it('round-trips with encodeBase64', () => {
    const original = 'héllo wörld 🌍';
    const encoded = (encodeBase64.handler({ text: original }) as { base64: string }).base64;
    const decoded = (decodeBase64.handler({ base64: encoded }) as DecodeBase64Result).text;
    expect(decoded).toBe(original);
  });

  it('throws on invalid base64 input', () => {
    expect(() => decodeBase64.handler({ base64: '!!!' })).toThrow(/Invalid base64 input/);
  });
});
