import { describe, expect, it } from 'vitest';

import { decodeQR, encodeQR, formatBits, versionBits, type QRMatrix } from '../src/qr-encode.js';

function finderPresent(m: QRMatrix, r0: number, c0: number): boolean {
  // 7x7 finder: dark border, light ring, dark 3x3 center.
  for (let dr = 0; dr < 7; dr++) {
    for (let dc = 0; dc < 7; dc++) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r >= m.length || c >= m.length) return false;
      const outer = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const inner = 2 <= dr && dr <= 4 && 2 <= dc && dc <= 4;
      const expected = outer || inner;
      if (m[r]![c] !== expected) return false;
    }
  }
  return true;
}

describe('encodeQR / decodeQR', () => {
  it('encodes a short string as version 1 at level L', () => {
    const r = encodeQR('HELLO WORLD', 'L');
    expect(r.version).toBe(1);
    expect(r.size).toBe(21);
    expect(r.ecLevel).toBe('L');
  });

  it('places the three finder patterns correctly', () => {
    const { matrix, size } = encodeQR('test', 'L');
    expect(finderPresent(matrix, 0, 0)).toBe(true);
    expect(finderPresent(matrix, 0, size - 7)).toBe(true);
    expect(finderPresent(matrix, size - 7, 0)).toBe(true);
  });

  it('places the always-dark module at (size-8, 8)', () => {
    const { matrix, size } = encodeQR('x', 'L');
    expect(matrix[size - 8]![8]).toBe(true);
  });

  it('has a timing pattern along row 6 and column 6', () => {
    const { matrix, size } = encodeQR('abc', 'L');
    for (let i = 8; i < size - 8; i++) {
      expect(matrix[6]![i]).toBe(i % 2 === 0);
      expect(matrix[i]![6]).toBe(i % 2 === 0);
    }
  });

  it('round-trips a short string through decodeQR', () => {
    const encoded = encodeQR('HELLO WORLD', 'L');
    const decoded = decodeQR(encoded.matrix);
    expect(decoded.text).toBe('HELLO WORLD');
    expect(decoded.level).toBe('L');
    expect(decoded.version).toBe(1);
  });

  it('round-trips across all four error-correction levels', () => {
    const text = 'The quick brown fox';
    for (const level of ['L', 'M', 'Q', 'H'] as const) {
      const encoded = encodeQR(text, level);
      const decoded = decodeQR(encoded.matrix);
      expect(decoded.text).toBe(text);
      expect(decoded.level).toBe(level);
    }
  });

  it('round-trips multi-byte UTF-8 (emoji)', () => {
    const text = 'QR ✓ — café';
    const encoded = encodeQR(text, 'M');
    const decoded = decodeQR(encoded.matrix);
    expect(decoded.text).toBe(text);
  });

  it('auto-selects larger versions for longer input', () => {
    const short = encodeQR('hi', 'L');
    const long = encodeQR('a'.repeat(200), 'L');
    expect(long.version).toBeGreaterThan(short.version);
    expect(long.size).toBe(4 * long.version + 17);
    expect(decodeQR(long.matrix).text).toBe('a'.repeat(200));
  });

  it('places alignment patterns at the documented coordinates for version 7', () => {
    const { matrix } = encodeQR('a'.repeat(150), 'L'); // forces v7 at L (v6 cap is 134)
    const centers: [number, number][] = [
      [6, 22],
      [22, 6],
      [22, 22],
      [22, 38],
      [38, 22],
      [38, 38],
    ];
    for (const [r, c] of centers) {
      // Center module of every alignment pattern is dark.
      expect(matrix[r]![c]).toBe(true);
    }
  });

  it('writes version info for v7+ that matches versionBits', () => {
    const encoded = encodeQR('a'.repeat(150), 'L'); // v7 at L
    if (encoded.version < 7) return; // n/a
    // Read 18-bit version info from the top-right block and compare.
    const { matrix, size } = encoded;
    let vbits = 0;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        vbits |= (matrix[i]![size - 11 + j] ? 1 : 0) << (j * 6 + i);
      }
    }
    expect(vbits).toBe(versionBits(encoded.version));
  });

  it('writes format info matching formatBits(level, mask) for the applied mask', () => {
    const encoded = encodeQR('format', 'Q');
    const decoded = decodeQR(encoded.matrix);
    // Read the top-left format copy and confirm it equals the canonical string.
    const { matrix } = encoded;
    let fmt = 0;
    const m = (r: number, c: number) => (matrix[r]![c] ? 1 : 0);
    for (let i = 0; i <= 5; i++) fmt |= m(i, 8) << i;
    fmt |= m(7, 8) << 6;
    fmt |= m(8, 8) << 7;
    fmt |= m(8, 7) << 8;
    for (let i = 9; i <= 14; i++) fmt |= m(8, 14 - i) << i;
    expect(fmt).toBe(formatBits(decoded.level, decoded.mask));
  });

  it('rejects empty input', () => {
    expect(() => encodeQR('', 'L')).toThrow(/non-empty/);
  });

  it('rejects input too long for versions 1–10', () => {
    expect(() => encodeQR('a'.repeat(271), 'L')).toThrow(/too long/);
  });

  it('produces a square matrix of the expected size', () => {
    const { matrix, size } = encodeQR('square', 'M');
    expect(matrix.length).toBe(size);
    expect(matrix.every((row) => row.length === size)).toBe(true);
  });
});
