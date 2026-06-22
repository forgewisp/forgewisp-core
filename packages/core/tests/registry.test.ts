import { describe, it, expect, beforeEach } from 'vitest';
import { FunctionRegistry } from '../src/registry.js';
import { FunctionDefinition } from '../src/types.js';

const mockDef: FunctionDefinition = {
  name: 'getUser',
  description: 'Get a user by ID',
  riskTier: 'read',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'User ID' } },
    required: ['id'],
  },
  handler: ({ id }) => ({ id, name: 'Alice' }),
};

describe('FunctionRegistry', () => {
  let registry: FunctionRegistry;

  beforeEach(() => {
    registry = new FunctionRegistry();
  });

  it('registers a function', () => {
    registry.register(mockDef);
    expect(registry.has('getUser')).toBe(true);
    expect(registry.size()).toBe(1);
  });

  it('throws on duplicate name', () => {
    registry.register(mockDef);
    expect(() => registry.register(mockDef)).toThrow('already registered');
  });

  it('deregisters a function', () => {
    registry.register(mockDef);
    registry.deregister('getUser');
    expect(registry.has('getUser')).toBe(false);
  });

  it('deregister is a no-op for unknown names', () => {
    expect(() => registry.deregister('nonexistent')).not.toThrow();
  });

  it('toLLMTools returns correct OpenAI tool spec', () => {
    registry.register(mockDef);
    const tools = registry.toLLMTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.type).toBe('function');
    expect(tools[0]!.function.name).toBe('getUser');
    expect(tools[0]!.function.parameters).toEqual(mockDef.parameters);
  });

  it('returns empty tools when nothing registered', () => {
    expect(registry.toLLMTools()).toEqual([]);
  });

  it('toLLMTools cache is invalidated on register/deregister', () => {
    registry.register(mockDef);
    const before = registry.toLLMTools();
    expect(before).toHaveLength(1);

    // Same array reference until the registry mutates.
    expect(registry.toLLMTools()).toBe(before);

    registry.deregister('getUser');
    expect(registry.toLLMTools()).toEqual([]);

    registry.register(mockDef);
    const after = registry.toLLMTools();
    expect(after).not.toBe(before);
    expect(after).toHaveLength(1);
  });

  it('get returns undefined for an unregistered name', () => {
    expect(registry.get('nope')).toBeUndefined();
  });

  it('getAll returns a copy that does not mutate the registry', () => {
    registry.register(mockDef);
    const all = registry.getAll();
    all.pop();
    expect(registry.getAll()).toHaveLength(1);
  });
});
