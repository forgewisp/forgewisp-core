import { describe, expect, it } from 'vitest';

import { evaluateExpression } from '../src/eval-math.js';

describe('evaluateExpression — happy path', () => {
  it('evaluates a plain sum', () => {
    expect(evaluateExpression('2+3')).toBe(5);
  });

  it('respects multiplication precedence over addition', () => {
    expect(evaluateExpression('2+3*4')).toBe(14);
  });

  it('respects parentheses', () => {
    expect(evaluateExpression('(2+3)*4')).toBe(20);
  });

  it('makes exponentiation right-associative', () => {
    expect(evaluateExpression('2^3^2')).toBe(512);
  });

  it('handles unary minus', () => {
    expect(evaluateExpression('-5')).toBe(-5);
    expect(evaluateExpression('-(2+3)')).toBe(-5);
    expect(evaluateExpression('2*-3')).toBe(-6);
    // Unary minus binds tighter than `^`: -2^2 = (-2)^2 = 4.
    expect(evaluateExpression('-2^2')).toBe(4);
  });

  it('treats unary plus as a no-op', () => {
    expect(evaluateExpression('+5')).toBe(5);
    expect(evaluateExpression('2*+3')).toBe(6);
  });

  it('handles modulo and division', () => {
    expect(evaluateExpression('10%3')).toBe(1);
    expect(evaluateExpression('10/4')).toBe(2.5);
  });

  it('parses decimals', () => {
    expect(evaluateExpression('1.5*2')).toBe(3);
    expect(evaluateExpression('0.1+0.2')).toBeCloseTo(0.3, 5);
  });

  it('ignores whitespace between tokens', () => {
    expect(evaluateExpression(' 1 +  2 ')).toBe(3);
    expect(evaluateExpression('2\t+\n3')).toBe(5);
  });

  it('handles nested parentheses', () => {
    expect(evaluateExpression('((1+2)*(3+4))')).toBe(21);
  });
});

describe('evaluateExpression — errors', () => {
  const invalid = [
    '',
    '   ',
    '1+',
    '1 2',
    ')(',
    '(1+2',
    '1+2)',
    '1/0',
    '1%0',
    '1..2',
    '.',
    '1.',
    '.5',
    'abc',
    'e^x',
    '__proto__',
    '1;system.exit()',
    'Math.pow(2,3)',
    'constructor',
    '2^10000',
    '()',
  ];
  for (const expr of invalid) {
    it(`throws for ${JSON.stringify(expr)}`, () => {
      expect(() => evaluateExpression(expr)).toThrow();
    });
  }

  it('reports division by zero specifically', () => {
    expect(() => evaluateExpression('1/0')).toThrow(/Division by zero/);
  });

  it('reports modulo by zero specifically', () => {
    expect(() => evaluateExpression('1%0')).toThrow(/Modulo by zero/);
  });

  it('reports overflow as a non-finite result', () => {
    expect(() => evaluateExpression('2^10000')).toThrow(/not finite/i);
  });

  it('rejects input longer than 200 characters', () => {
    expect(() => evaluateExpression('1+'.repeat(101) + '1')).toThrow(/1\.\.200/);
  });

  it('rejects a lone dot', () => {
    expect(() => evaluateExpression('.')).toThrow();
  });
});
