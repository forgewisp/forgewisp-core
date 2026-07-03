import { describe, expect, it } from 'vitest';

import { convertColor } from '../src/tools/convert-color.js';
import type { ConvertColorResult } from '../src/tools/convert-color.js';

describe('convertColor', () => {
  it('has the correct FunctionDefinition shape', () => {
    expect(convertColor.name).toBe('convertColor');
    expect(convertColor.riskTier).toBe('read');
    expect(typeof convertColor.handler).toBe('function');

    const { parameters } = convertColor;
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['color']);
    expect(parameters.additionalProperties).toBe(false);

    const color = parameters.properties.color;
    expect(color).toBeDefined();
    expect(color?.type).toBe('string');
    expect(color?.minLength).toBe(1);
    expect(color?.maxLength).toBe(64);
  });

  it('parses #rrggbb hex input and returns all three representations', () => {
    const r = convertColor.handler({ color: '#ff8800' }) as ConvertColorResult;
    expect(r.inputFormat).toBe('hex');
    expect(r.hex).toBe('#ff8800');
    expect(r.rgb).toEqual({ r: 255, g: 136, b: 0 });
    // hsl(32, 100%, 50%)
    expect(r.hsl.h).toBe(32);
    expect(r.hsl.s).toBe(100);
    expect(r.hsl.l).toBe(50);
  });

  it('expands #rgb shorthand', () => {
    const r = convertColor.handler({ color: '#f80' }) as ConvertColorResult;
    expect(r.hex).toBe('#ff8800');
    expect(r.rgb).toEqual({ r: 255, g: 136, b: 0 });
  });

  it('parses rgb() input', () => {
    const r = convertColor.handler({ color: 'rgb(255, 136, 0)' }) as ConvertColorResult;
    expect(r.inputFormat).toBe('rgb');
    expect(r.hex).toBe('#ff8800');
  });

  it('parses hsl() input', () => {
    const r = convertColor.handler({ color: 'hsl(32, 100%, 50%)' }) as ConvertColorResult;
    expect(r.inputFormat).toBe('hsl');
    expect(r.rgb).toEqual({ r: 255, g: 136, b: 0 });
    expect(r.hex).toBe('#ff8800');
  });

  it('parses basic named colors', () => {
    const r = convertColor.handler({ color: 'red' }) as ConvertColorResult;
    expect(r.inputFormat).toBe('named');
    expect(r.hex).toBe('#ff0000');
    expect(r.rgb).toEqual({ r: 255, g: 0, b: 0 });

    const navy = convertColor.handler({ color: 'NAVY' }) as ConvertColorResult;
    expect(navy.hex).toBe('#000080');
  });

  it('round-trips black and white through hsl', () => {
    const black = convertColor.handler({ color: '#000000' }) as ConvertColorResult;
    expect(black.hsl).toEqual({ h: 0, s: 0, l: 0 });
    expect(black.hex).toBe('#000000');

    const white = convertColor.handler({ color: '#ffffff' }) as ConvertColorResult;
    expect(white.hsl).toEqual({ h: 0, s: 0, l: 100 });
    expect(white.hex).toBe('#ffffff');
  });

  it('throws on invalid hex', () => {
    expect(() => convertColor.handler({ color: '#xyz' })).toThrow(/Invalid hex color/);
    expect(() => convertColor.handler({ color: 'ff8800' })).toThrow(/Unrecognized color/);
    expect(() => convertColor.handler({ color: '#ff88' })).toThrow(/Invalid hex color/);
  });

  it('throws on out-of-range rgb channels', () => {
    expect(() => convertColor.handler({ color: 'rgb(300, 0, 0)' })).toThrow(/red/);
    expect(() => convertColor.handler({ color: 'rgb(0, 0, 256)' })).toThrow(/blue/);
  });

  it('throws on out-of-range hsl channels', () => {
    expect(() => convertColor.handler({ color: 'hsl(400, 50%, 50%)' })).toThrow(/hue/);
    expect(() => convertColor.handler({ color: 'hsl(0, 150%, 50%)' })).toThrow(/saturation/);
  });

  it('throws on unrecognized input', () => {
    expect(() => convertColor.handler({ color: 'banana' })).toThrow(/Unrecognized color/);
  });
});
