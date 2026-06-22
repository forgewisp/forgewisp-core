import { describe, it, expect, vi, beforeEach, afterEach, MockInstance } from 'vitest';
import Ajv from 'ajv';
import { validateArgs } from '../src/validator.js';
import { JSONSchema } from '../src/types.js';

const schema: JSONSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    age: { type: 'integer', minimum: 0 },
    role: { type: 'string', enum: ['admin', 'user'] },
  },
  required: ['name', 'age'],
};

describe('validateArgs', () => {
  it('passes valid args', () => {
    const result = validateArgs({ name: 'Alice', age: 30 }, schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when required field is missing', () => {
    const result = validateArgs({ name: 'Alice' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('age') || e.includes('required'))).toBe(true);
  });

  it('fails on wrong type', () => {
    const result = validateArgs({ name: 'Alice', age: 'thirty' }, schema);
    expect(result.valid).toBe(false);
  });

  it('fails on enum violation', () => {
    const result = validateArgs({ name: 'Alice', age: 30, role: 'superadmin' }, schema);
    expect(result.valid).toBe(false);
  });

  it('fails on minLength violation', () => {
    const result = validateArgs({ name: '', age: 30 }, schema);
    expect(result.valid).toBe(false);
  });

  it('passes with optional field provided correctly', () => {
    const result = validateArgs({ name: 'Alice', age: 30, role: 'admin' }, schema);
    expect(result.valid).toBe(true);
  });

  it('validates array type and items via nested property', () => {
    const arrSchema: JSONSchema = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'integer', minimum: 0 } },
      },
      required: ['items'],
    };
    expect(validateArgs({ items: [1, 2, 3] }, arrSchema).valid).toBe(true);
    expect(validateArgs({ items: [1, -1, 3] }, arrSchema).valid).toBe(false);
    expect(validateArgs({ items: 'not-array' }, arrSchema).valid).toBe(false);
  });

  it('validates nested object properties', () => {
    const nested: JSONSchema = {
      type: 'object',
      properties: {
        addr: {
          type: 'object',
          properties: {
            city: { type: 'string' },
            zip: { type: 'string' },
          },
          required: ['city'],
        },
      },
      required: ['addr'],
    };
    expect(validateArgs({ addr: { city: 'SF', zip: '94101' } }, nested).valid).toBe(true);
    expect(validateArgs({ addr: { zip: '94101' } }, nested).valid).toBe(false);
  });

  it('rejects unknown properties when additionalProperties is false', () => {
    const strict: JSONSchema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    };
    expect(validateArgs({ a: 'x' }, strict).valid).toBe(true);
    expect(validateArgs({ a: 'x', b: 'y' }, strict).valid).toBe(false);
  });

  it('accepts null when a property type allows it', () => {
    const nullable: JSONSchema = {
      type: 'object',
      properties: { v: { type: 'null' } },
      required: ['v'],
    };
    expect(validateArgs({ v: null }, nullable).valid).toBe(true);
    expect(validateArgs({ v: 0 }, nullable).valid).toBe(false);
  });

  it('rejects values that do not match any of multiple types', () => {
    const multi: JSONSchema = {
      type: 'object',
      properties: { v: { type: 'string' as const } },
      required: ['v'],
    };
    expect(validateArgs({ v: 'hello' }, multi).valid).toBe(true);
    expect(validateArgs({ v: 42 }, multi).valid).toBe(false);
  });

  describe('compile cache', () => {
    let compileSpy: MockInstance;

    beforeEach(() => {
      compileSpy = vi.spyOn(Ajv.prototype, 'compile');
    });

    afterEach(() => {
      compileSpy.mockRestore();
    });

    it('compiles a schema only once across repeated calls', () => {
      const cachedSchema: JSONSchema = {
        type: 'object',
        properties: { x: { type: 'integer' } },
        required: ['x'],
      };
      for (let i = 0; i < 1000; i++) {
        validateArgs({ x: i }, cachedSchema);
      }
      expect(compileSpy).toHaveBeenCalledTimes(1);
    });

    it('compiles once per distinct schema object', () => {
      const a: JSONSchema = { type: 'object', properties: { x: { type: 'integer' } } };
      const b: JSONSchema = { type: 'object', properties: { y: { type: 'string' } } };
      validateArgs({ x: 1 }, a);
      validateArgs({ x: 2 }, a);
      validateArgs({ y: 's' }, b);
      validateArgs({ y: 't' }, b);
      expect(compileSpy).toHaveBeenCalledTimes(2);
    });
  });
});
