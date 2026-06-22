import { describe, expect, it } from 'vitest';

import { generateUuid } from '../src/tools/generate-uuid.js';
import type { GenerateUuidResult } from '../src/tools/generate-uuid.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateUuid', () => {
  it('has the correct FunctionDefinition shape', () => {
    expect(generateUuid.name).toBe('generateUuid');
    expect(generateUuid.riskTier).toBe('read');
    expect(typeof generateUuid.handler).toBe('function');
    expect(generateUuid.parameters.type).toBe('object');
    expect(generateUuid.parameters.required).toEqual([]);
    expect(generateUuid.parameters.additionalProperties).toBe(false);
  });

  it('returns a valid v4 UUID', () => {
    const result = generateUuid.handler({}) as GenerateUuidResult;
    expect(result.uuid).toMatch(UUID_V4);
  });

  it('returns distinct UUIDs across calls', () => {
    const a = generateUuid.handler({}) as GenerateUuidResult;
    const b = generateUuid.handler({}) as GenerateUuidResult;
    expect(a.uuid).not.toBe(b.uuid);
  });
});
