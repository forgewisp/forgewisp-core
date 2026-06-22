import { describe, expect, it } from 'vitest';

import { evaluateMath } from '../src/tools/evaluate-math.js';
import type { EvaluateMathResult } from '../src/tools/evaluate-math.js';

describe('evaluateMath', () => {
  it('has the correct FunctionDefinition shape', () => {
    expect(evaluateMath.name).toBe('evaluateMath');
    expect(evaluateMath.riskTier).toBe('read');
    expect(typeof evaluateMath.handler).toBe('function');
    const expression = evaluateMath.parameters.properties.expression;
    expect(expression?.type).toBe('string');
    expect(expression?.minLength).toBe(1);
    expect(expression?.maxLength).toBe(200);
    expect(evaluateMath.parameters.required).toEqual(['expression']);
    expect(evaluateMath.parameters.additionalProperties).toBe(false);
  });

  it('evaluates arithmetic', () => {
    expect((evaluateMath.handler({ expression: '2+3*4' }) as EvaluateMathResult).value).toBe(14);
    expect((evaluateMath.handler({ expression: '(2+3)*4' }) as EvaluateMathResult).value).toBe(20);
    expect((evaluateMath.handler({ expression: '2^3^2' }) as EvaluateMathResult).value).toBe(512);
    expect((evaluateMath.handler({ expression: '10%3' }) as EvaluateMathResult).value).toBe(1);
  });

  it('throws on invalid input', () => {
    expect(() => evaluateMath.handler({ expression: '1/0' })).toThrow(/Division by zero/);
    expect(() => evaluateMath.handler({ expression: 'abc' })).toThrow();
    expect(() => evaluateMath.handler({ expression: '__proto__' })).toThrow();
  });
});
