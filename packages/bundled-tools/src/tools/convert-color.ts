import type { FunctionDefinition, JSONSchema } from '@forgewisp/core';
import { defineTool } from '../define-tool.js';

// ─── Args & result ──────────────────────────────────────────────────────────

export interface ConvertColorArgs {
  /** The input color: hex (#rgb / #rrggbb), rgb(r,g,b), hsl(h,s%,l%), or a basic CSS named color. */
  color: string;
}

export interface ConvertColorResult {
  /** The detected input format. */
  inputFormat: 'hex' | 'rgb' | 'hsl' | 'named';
  /** Hex string, e.g. "#ff8800". */
  hex: string;
  /** RGB channels, 0–255. */
  rgb: { r: number; g: number; b: number };
  /** HSL channels: h 0–360, s/l 0–100. */
  hsl: { h: number; s: number; l: number };
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const parameters: JSONSchema = {
  type: 'object',
  properties: {
    color: {
      type: 'string',
      description:
        'The color to convert. Accepts "#rgb" / "#rrggbb" hex, "rgb(r,g,b)", ' +
        '"hsl(h,s%,l%)", or a basic CSS named color (black, white, red, ...).',
      minLength: 1,
      maxLength: 64,
    },
  },
  required: ['color'],
  additionalProperties: false,
};

// ─── Parsing ────────────────────────────────────────────────────────────────

// The 16 basic CSS / HTML4 named colors.
const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  silver: '#c0c0c0',
  gray: '#808080',
  grey: '#808080',
  maroon: '#800000',
  olive: '#808000',
  lime: '#00ff00',
  purple: '#800080',
  teal: '#008080',
  navy: '#000080',
};

function clampInt(n: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(n) || n < min || n > max || Math.floor(n) !== n) {
    throw new Error(`${label} must be an integer in [${min}, ${max}], got "${n}".`);
  }
  return n;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.trim();
  if (!h.startsWith('#')) {
    throw new Error(`Invalid hex color "${hex}": must start with "#".`);
  }
  h = h.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(h)) {
    throw new Error(`Invalid hex color "${hex}": non-hex characters.`);
  }
  if (h.length === 3) {
    h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  }
  if (h.length !== 6) {
    throw new Error(`Invalid hex color "${hex}": expected #rgb or #rrggbb.`);
  }
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return { r, g, b };
}

function parseRgb(s: string): { r: number; g: number; b: number } {
  const m = /^rgb\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)$/i.exec(s.trim());
  if (!m) throw new Error(`Invalid rgb() color "${s}". Expected rgb(r,g,b) with 0–255.`);
  return {
    r: clampInt(Number(m[1]), 0, 255, 'red'),
    g: clampInt(Number(m[2]), 0, 255, 'green'),
    b: clampInt(Number(m[3]), 0, 255, 'blue'),
  };
}

function parseHsl(input: string): { h: number; s: number; l: number } {
  const m = /^hsl\(\s*([0-9.]+)\s*,\s*([0-9.]+)%\s*,\s*([0-9.]+)%\s*\)$/i.exec(input.trim());
  if (!m) throw new Error(`Invalid hsl() color "${input}". Expected hsl(h,s%,l%) with h 0–360.`);
  const h = Number(m[1]);
  const s = Number(m[2]);
  const l = Number(m[3]);
  if (!Number.isFinite(h) || h < 0 || h > 360) {
    throw new Error(`HSL hue must be in [0, 360], got "${h}".`);
  }
  if (!Number.isFinite(s) || s < 0 || s > 100) {
    throw new Error(`HSL saturation must be in [0, 100], got "${s}".`);
  }
  if (!Number.isFinite(l) || l < 0 || l > 100) {
    throw new Error(`HSL lightness must be in [0, 100], got "${l}".`);
  }
  return { h, s, l };
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const to2 = (n: number) => n.toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }): {
  h: number;
  s: number;
  l: number;
} {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }
    h *= 60;
  }
  return {
    h: Math.round(h),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): {
  r: number;
  g: number;
  b: number;
} {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = ln - c / 2;
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

function toRgb(color: string): {
  rgb: { r: number; g: number; b: number };
  inputFormat: ConvertColorResult['inputFormat'];
} {
  const c = color.trim();
  if (c.startsWith('#')) {
    return { rgb: hexToRgb(c), inputFormat: 'hex' };
  }
  const lower = c.toLowerCase();
  if (lower.startsWith('rgb(') && c.endsWith(')')) {
    return { rgb: parseRgb(c), inputFormat: 'rgb' };
  }
  if (lower.startsWith('hsl(') && c.endsWith(')')) {
    return { rgb: hslToRgb(parseHsl(c)), inputFormat: 'hsl' };
  }
  const named = NAMED[lower];
  if (named) {
    return { rgb: hexToRgb(named), inputFormat: 'named' };
  }
  throw new Error(
    `Unrecognized color "${color}". Use #hex, rgb(r,g,b), hsl(h,s%,l%), or a basic CSS named color.`,
  );
}

// ─── Tool definition ─────────────────────────────────────────────────────────

export const convertColor: FunctionDefinition<ConvertColorArgs> = defineTool({
  name: 'convertColor',
  description:
    'Convert a color between hex, rgb, and hsl. Accepts "#rgb" / "#rrggbb" hex, ' +
    '"rgb(r,g,b)", "hsl(h,s%,l%)", or a basic CSS named color. Returns all three ' +
    'representations (hex, rgb, hsl).',
  riskTier: 'read',
  parameters,
  handler: (args: ConvertColorArgs): ConvertColorResult => {
    const { rgb, inputFormat } = toRgb(args.color);
    return {
      inputFormat,
      hex: rgbToHex(rgb),
      rgb,
      hsl: rgbToHsl(rgb),
    };
  },
});
