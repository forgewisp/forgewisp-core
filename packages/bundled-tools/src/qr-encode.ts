/**
 * A tiny, self-contained QR code encoder (byte mode, versions 1–10, levels L/M/Q/H).
 *
 * No external dependencies, no `eval`/`Function`. This is deliberately an internal
 * helper — like `eval-math.ts` / `plan-store.ts` — and is NOT re-exported from the
 * package barrel. It exists only so `generate-qr-code.ts` can render a QR matrix to
 * a `<canvas>` without pulling a QR library into the runtime bundle.
 *
 * Scope: byte-mode encoding only (the right choice for arbitrary UTF-8 text),
 * versions 1–10 (covers up to ~270 bytes at level L / ~111 at level H — enough for
 * URLs and short text). Mask selection uses the four ISO/IEC 18004 penalty rules
 * (rule 3 — finder-like runs — is applied in its common simplified form; this only
 * affects optimality of the chosen mask, never scannability, since the decoder reads
 * the applied mask from the format string).
 *
 * Pipeline: encodeData → placeFunctionPatterns → placeData → mask selection →
 * format/version info.
 */

export type QRMatrix = boolean[][];

export interface QREncodeResult {
  /** Module matrix, `[row][col]`, `true` = dark. */
  matrix: QRMatrix;
  /** QR version (1–10). */
  version: number;
  /** Edge length in modules: `4 * version + 17`. */
  size: number;
  /** Error-correction level used. */
  ecLevel: 'L' | 'M' | 'Q' | 'H';
  /** Number of dark modules (informational). */
  darkModules: number;
}

export type ECLevel = 'L' | 'M' | 'Q' | 'H';

// ─── Galois field GF(256), generator 0x11d ───────────────────────────────────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGenerator(degree: number): number[] {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const ng = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ng[j] = (ng[j] ?? 0) ^ g[j]!; // x * g[j]
      ng[j + 1] = (ng[j + 1] ?? 0) ^ gfMul(g[j]!, GF_EXP[i]!); // α^i * g[j]
    }
    g = ng;
  }
  return g;
}

function rsEncode(data: number[], eccCount: number): number[] {
  const gen = rsGenerator(eccCount);
  const buf = data.concat(new Array(eccCount).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i]!;
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      buf[i + j] = (buf[i + j] ?? 0) ^ gfMul(gen[j]!, coef);
    }
  }
  return buf.slice(data.length);
}

// ─── Error-correction layout (versions 1–10) ────────────────────────────────
// [ecCodewordsPerBlock, group1Blocks, group1DataPerBlock, group2Blocks, group2DataPerBlock]
// Source: ISO/IEC 18004 Table D.1 (verified against total-codeword sums).

const EC_LAYOUT: Record<ECLevel, number[][]> = {
  L: [
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
  ],
  Q: [
    [13, 1, 13, 0, 0],
    [22, 1, 22, 0, 0],
    [18, 2, 17, 0, 0],
    [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0],
    [18, 2, 14, 4, 15],
    [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17],
    [24, 6, 19, 2, 20],
  ],
  H: [
    [17, 1, 9, 0, 0],
    [28, 1, 16, 0, 0],
    [22, 2, 13, 0, 0],
    [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0],
    [26, 4, 13, 1, 14],
    [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13],
    [28, 6, 15, 2, 16],
  ],
};

// Alignment-pattern center coordinates (full axis positions, including the 6 that
// coincides with the finder edge) per version 1–10. The three finder-corner overlaps
// are skipped during placement (see buildBaseMatrix).
const ALIGNMENT_POS: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const EC_LEVEL_BITS: Record<ECLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// ─── Version / format BCH helpers ────────────────────────────────────────────

export function formatBits(ecLevel: ECLevel, mask: number): number {
  const data = (EC_LEVEL_BITS[ecLevel] << 3) | (mask & 7); // 5-bit format data
  let buf = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((buf >> i) & 1) buf ^= 0x537 << (i - 10);
  }
  return (((data << 10) | (buf & 0x3ff)) ^ 0x5412) & 0x7fff;
}

export function versionBits(version: number): number {
  let buf = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((buf >> i) & 1) buf ^= 0x1f25 << (i - 12);
  }
  return ((version << 12) | (buf & 0xfff)) & 0x3ffff;
}

// ─── Mask patterns ───────────────────────────────────────────────────────────

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

// ─── Data encoding ───────────────────────────────────────────────────────────

function lengthBitsFor(version: number): number {
  // byte-mode character-count indicator bit width
  return version <= 9 ? 8 : 16;
}

function totalDataCodewords(version: number, level: ECLevel): number {
  const layout = EC_LAYOUT[level][version - 1]!;
  return layout[1]! * layout[2]! + layout[3]! * layout[4]!;
}

function encodeDataBytes(textBytes: number[], version: number, level: ECLevel): number[] {
  const dataCount = totalDataCodewords(version, level);
  const lb = lengthBitsFor(version);
  // Build the bit stream as an array of bits.
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(textBytes.length, lb);
  for (const b of textBytes) push(b, 8);

  // Terminator (up to 4 zero bits, fewer if near the end).
  const totalBits = dataCount * 8;
  const remaining = totalBits - bits.length;
  push(0, Math.min(4, Math.max(0, remaining)));

  // Pad to a byte boundary.
  while (bits.length % 8 !== 0) bits.push(0);

  // Convert to bytes.
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]!;
    bytes.push(v);
  }
  // Pad with alternating 0xEC / 0x11 until we reach dataCount.
  const pad = [0xec, 0x11];
  let pi = 0;
  while (bytes.length < dataCount) bytes.push(pad[pi++ % 2]!);
  return bytes;
}

function interleave(dataBytes: number[], version: number, level: ECLevel): number[] {
  const layout = EC_LAYOUT[level][version - 1]!;
  const ecPerBlock = layout[0]!;
  const g1b = layout[1]!;
  const g1d = layout[2]!;
  const g2b = layout[3]!;
  const g2d = layout[4]!;
  const blocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let offset = 0;
  const addBlocks = (count: number, perBlock: number) => {
    for (let i = 0; i < count; i++) {
      const data = dataBytes.slice(offset, offset + perBlock);
      offset += perBlock;
      blocks.push(data);
      eccBlocks.push(rsEncode(data, ecPerBlock));
    }
  };
  addBlocks(g1b, g1d);
  addBlocks(g2b, g2d);

  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i]!);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const b of eccBlocks) out.push(b[i]!);
  }
  return out;
}

// ─── Matrix construction ────────────────────────────────────────────────────

function pickVersion(byteLen: number, level: ECLevel): number {
  for (let v = 1; v <= 10; v++) {
    const lb = lengthBitsFor(v);
    const required = 4 + lb + 8 * byteLen;
    if (required <= totalDataCodewords(v, level) * 8) return v;
  }
  throw new Error(
    `Text too long for QR versions 1–10 at level ${level} (${byteLen} bytes). ` +
      'Reduce the input or lower the error-correction level.',
  );
}

function setFinder(matrix: number[][], reserved: boolean[][], r0: number, c0: number): void {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r < 0 || c < 0 || r >= matrix.length || c >= matrix.length) continue;
      reserved[r]![c] = true;
      const isBorder = dr === -1 || dr === 7 || dc === -1 || dc === 7; // separator
      if (isBorder) {
        matrix[r]![c] = 0;
      } else {
        const outer = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inner = 2 <= dr && dr <= 4 && 2 <= dc && dc <= 4;
        matrix[r]![c] = outer || inner ? 1 : 0;
      }
    }
  }
}

function setAlignment(matrix: number[][], reserved: boolean[][], r0: number, c0: number): void {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const r = r0 + dr;
      const c = c0 + dc;
      reserved[r]![c] = true;
      const outer = Math.abs(dr) === 2 || Math.abs(dc) === 2;
      const center = dr === 0 && dc === 0;
      matrix[r]![c] = outer || center ? 1 : 0;
    }
  }
}

function buildBaseMatrix(version: number): { matrix: number[][]; reserved: boolean[][] } {
  const size = 4 * version + 17;
  const matrix: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );

  // Finders + separators.
  setFinder(matrix, reserved, 0, 0);
  setFinder(matrix, reserved, 0, size - 7);
  setFinder(matrix, reserved, size - 7, 0);

  // Alignment patterns.
  const pos = ALIGNMENT_POS[version]!;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const r = pos[i]!;
      const c = pos[j]!;
      // Skip the three finder corners.
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === pos.length - 1) ||
        (j === 0 && i === pos.length - 1)
      ) {
        continue;
      }
      setAlignment(matrix, reserved, r, c);
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    matrix[6]![i] = i % 2 === 0 ? 1 : 0;
    matrix[i]![6] = i % 2 === 0 ? 1 : 0;
    reserved[6]![i] = true;
    reserved[i]![6] = true;
  }

  // Dark module.
  matrix[size - 8]![8] = 1;
  reserved[size - 8]![8] = true;

  // Reserve format-info areas (filled after masking).
  for (let i = 0; i < 9; i++) reserved[8]![i] = true; // row 8, cols 0..8
  for (let i = 0; i < 8; i++) reserved[i]![8] = true; // col 8, rows 0..7
  for (let i = 0; i < 7; i++) reserved[size - 1 - i]![8] = true; // col 8, rows size-1..size-7 (7)
  for (let i = 0; i < 8; i++) reserved[8]![size - 1 - i] = true; // row 8, cols size-1..size-8 (8)

  // Reserve version-info areas (v7+), filled later.
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[i]![size - 11 + j] = true;
        reserved[size - 11 + j]![i] = true;
      }
    }
  }

  return { matrix, reserved };
}

function placeData(matrix: number[][], reserved: boolean[][], dataBytes: number[]): void {
  const size = matrix.length;
  const bits: number[] = [];
  for (const byte of dataBytes) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }
  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const actualCol = col - c;
        if (!reserved[row]![actualCol]) {
          matrix[row]![actualCol] = bitIdx < bits.length ? bits[bitIdx]! : 0;
          bitIdx++;
        }
      }
    }
    upward = !upward;
  }
}

// ─── Penalty rules ───────────────────────────────────────────────────────────

function penalty1(matrix: number[][]): number {
  const size = matrix.length;
  let p = 0;
  for (let r = 0; r < size; r++) {
    let runColor = -1;
    let runLen = 0;
    for (let c = 0; c < size; c++) {
      const v = matrix[r]![c]!;
      if (v === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) p += runLen - 2;
        runColor = v;
        runLen = 1;
      }
    }
    if (runLen >= 5) p += runLen - 2;
  }
  for (let c = 0; c < size; c++) {
    let runColor = -1;
    let runLen = 0;
    for (let r = 0; r < size; r++) {
      const v = matrix[r]![c]!;
      if (v === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) p += runLen - 2;
        runColor = v;
        runLen = 1;
      }
    }
    if (runLen >= 5) p += runLen - 2;
  }
  return p;
}

function penalty2(matrix: number[][]): number {
  const size = matrix.length;
  let p = 0;
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r]![c]!;
      if (v === matrix[r]![c + 1] && v === matrix[r + 1]![c] && v === matrix[r + 1]![c + 1]) p += 3;
    }
  }
  return p;
}

function penalty3(matrix: number[][]): number {
  const size = matrix.length;
  const target = [1, 0, 1, 1, 1, 0, 1];
  let p = 0;
  const checkLine = (line: number[]) => {
    for (let i = 0; i <= line.length - 7; i++) {
      let match = true;
      for (let k = 0; k < 7; k++) {
        if (line[i + k] !== target[k]) {
          match = false;
          break;
        }
      }
      if (!match) continue;
      const before = i >= 4 && line.slice(i - 4, i).every((x) => x === 0);
      const after = i + 11 <= line.length && line.slice(i + 7, i + 11).every((x) => x === 0);
      if (before || after) p += 40;
    }
  };
  for (let r = 0; r < size; r++) checkLine(matrix[r]!);
  for (let c = 0; c < size; c++) {
    const col = matrix.map((row) => row[c]!);
    checkLine(col);
  }
  return p;
}

function penalty4(matrix: number[][]): number {
  const size = matrix.length;
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (matrix[r]![c]) dark++;
  const percent = (dark * 100) / (size * size);
  return Math.floor(Math.abs(percent - 50) / 5) * 10;
}

function totalPenalty(matrix: number[][]): number {
  return penalty1(matrix) + penalty2(matrix) + penalty3(matrix) + penalty4(matrix);
}

function applyMask(matrix: number[][], reserved: boolean[][], mask: number): number[][] {
  const size = matrix.length;
  const copy = matrix.map((row) => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r]![c] && maskCondition(mask, r, c)) {
        copy[r]![c] = (copy[r]![c] ?? 0) ^ 1;
      }
    }
  }
  return copy;
}

// ─── Format / version info placement ────────────────────────────────────────

function placeFormatInfo(matrix: number[][], size: number, fmt: number): void {
  const bit = (i: number) => (fmt >> i) & 1;
  // First copy (top-left).
  for (let i = 0; i <= 5; i++) matrix[i]![8] = bit(i);
  matrix[7]![8] = bit(6);
  matrix[8]![8] = bit(7);
  matrix[8]![7] = bit(8);
  for (let i = 9; i <= 14; i++) matrix[8]![14 - i] = bit(i);
  // Second copy.
  for (let i = 0; i <= 6; i++) matrix[size - 1 - i]![8] = bit(i);
  for (let i = 0; i <= 7; i++) matrix[8]![size - 1 - i] = bit(14 - i);
}

function placeVersionInfo(matrix: number[][], size: number, vbits: number): void {
  const bit = (i: number) => (vbits >> i) & 1;
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      matrix[i]![size - 11 + j] = bit(j * 6 + i);
      matrix[size - 11 + j]![i] = bit(j * 6 + i);
    }
  }
}

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Encode `text` (UTF-8) into a QR code matrix at the requested error-correction
 * level, auto-selecting the smallest version (1–10) that fits.
 *
 * @throws Error if the text is empty, too long for versions 1–10, or contains
 *   non-finite UTF-8 byte values.
 */
export function encodeQR(text: string, level: ECLevel = 'M'): QREncodeResult {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('QR input text must be a non-empty string.');
  }
  const textBytes = Array.from(new TextEncoder().encode(text));
  if (textBytes.length > 270) {
    throw new Error(
      `QR input too long (${textBytes.length} bytes); versions 1–10 hold at most 270 bytes.`,
    );
  }
  const version = pickVersion(textBytes.length, level);
  const size = 4 * version + 17;

  const dataBytes = encodeDataBytes(textBytes, version, level);
  const interleaved = interleave(dataBytes, version, level);

  const { matrix, reserved } = buildBaseMatrix(version);
  placeData(matrix, reserved, interleaved);

  // Select the lowest-penalty mask. Retain the winning masked matrix so we
  // don't redo the O(size²) mask pass a 9th time after the loop.
  let bestMask = 0;
  let bestMasked = applyMask(matrix, reserved, 0);
  let bestPenalty = totalPenalty(bestMasked);
  for (let m = 1; m < 8; m++) {
    const masked = applyMask(matrix, reserved, m);
    const pen = totalPenalty(masked);
    if (pen < bestPenalty) {
      bestPenalty = pen;
      bestMask = m;
      bestMasked = masked;
    }
  }
  const finalMatrix = bestMasked;

  placeFormatInfo(finalMatrix, size, formatBits(level, bestMask));
  if (version >= 7) placeVersionInfo(finalMatrix, size, versionBits(version));

  // Counted after format/version-info placement, which adds dark modules of its
  // own — this is NOT the same as penalty4's pre-placement dark count.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (finalMatrix[r]![c]) dark++;

  return {
    matrix: finalMatrix.map((row) => row.map((v) => v === 1)),
    version,
    size,
    ecLevel: level,
    darkModules: dark,
  };
}

// ─── Decoder (test-only round-trip) ─────────────────────────────────────────
// Not re-exported from the package barrel. Used by the test suite to validate the
// encode pipeline without an external scanner: decodeQR(encodeQR(text).matrix)
// must recover the original text + level + version.

function readFormatInfo(matrix: boolean[][]): number {
  const m = (r: number, c: number) => (matrix[r]![c] ? 1 : 0);
  let fmt = 0;
  for (let i = 0; i <= 5; i++) fmt |= m(i, 8) << i;
  fmt |= m(7, 8) << 6;
  fmt |= m(8, 8) << 7;
  fmt |= m(8, 7) << 8;
  for (let i = 9; i <= 14; i++) fmt |= m(8, 14 - i) << i;
  return fmt;
}

function matchFormat(fmt: number): { level: ECLevel; mask: number } {
  for (const lv of ['L', 'M', 'Q', 'H'] as ECLevel[]) {
    for (let mask = 0; mask < 8; mask++) {
      if (formatBits(lv, mask) === fmt) return { level: lv, mask };
    }
  }
  throw new Error('Unrecognized format info — QR is malformed.');
}

function readVersionInfo(matrix: boolean[][]): number {
  // Read the 18-bit version info (v7+) from the top-right block.
  const size = matrix.length;
  let vbits = 0;
  const m = (r: number, c: number) => (matrix[r]![c] ? 1 : 0);
  for (let i = 0; i < 6; i++) {
    for (let j = 0; j < 3; j++) {
      vbits |= m(i, size - 11 + j) << (j * 6 + i);
    }
  }
  // Recover the 6-bit version number.
  for (let v = 7; v <= 40; v++) {
    if (versionBits(v) === vbits) return v;
  }
  throw new Error('Unrecognized version info.');
}

function readDataBits(matrix: boolean[][], reserved: boolean[][], mask: number): number[] {
  const size = matrix.length;
  const bits: number[] = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const actualCol = col - c;
        if (!reserved[row]![actualCol]) {
          let v = matrix[row]![actualCol] ? 1 : 0;
          if (maskCondition(mask, row, actualCol)) v ^= 1;
          bits.push(v);
        }
      }
    }
    upward = !upward;
  }
  return bits;
}

function deinterleaveData(stream: number[], version: number, level: ECLevel): number[] {
  const layout = EC_LAYOUT[level][version - 1]!;
  const g1b = layout[1]!;
  const g1d = layout[2]!;
  const g2b = layout[3]!;
  const g2d = layout[4]!;
  const numBlocks = g1b + g2b;
  const blockLen = (b: number) => (b < g1b ? g1d : g2d);
  const blocks: number[][] = Array.from({ length: numBlocks }, () => []);
  let idx = 0;
  const maxData = Math.max(g1d, g2d);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < blockLen(b)) blocks[b]!.push(stream[idx++]!);
    }
  }
  return blocks.flat();
}

/**
 * Decode a QR matrix back to its text + level + version. Test-only: validates the
 * encoder's data placement, masking, interleaving, and format/version info by
 * round-tripping. Does NOT perform error correction (assumes a clean encode).
 */
export function decodeQR(matrix: boolean[][]): {
  text: string;
  level: ECLevel;
  version: number;
  mask: number;
} {
  const size = matrix.length;
  const version = (size - 17) / 4;
  if (!Number.isInteger(version) || version < 1 || version > 10) {
    throw new Error(`Unexpected QR size ${size}.`);
  }
  if (version >= 7) {
    const v = readVersionInfo(matrix);
    if (v !== version) throw new Error(`Version info mismatch: ${v} vs ${version}.`);
  }
  const fmt = readFormatInfo(matrix);
  const { level, mask } = matchFormat(fmt);

  const { reserved } = buildBaseMatrix(version);
  const bits = readDataBits(matrix, reserved, mask);
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]!;
    codewords.push(v);
  }
  const dataCodewords = deinterleaveData(codewords, version, level);

  // Parse the bit stream.
  const dbits: number[] = [];
  for (const byte of dataCodewords) {
    for (let i = 7; i >= 0; i--) dbits.push((byte >> i) & 1);
  }
  let p = 0;
  const read = (width: number) => {
    let v = 0;
    for (let i = 0; i < width; i++) v = (v << 1) | dbits[p++]!;
    return v;
  };
  const mode = read(4);
  if (mode !== 0b0100)
    throw new Error(`Unsupported mode ${mode.toString(2)} (byte mode expected).`);
  const length = read(lengthBitsFor(version));
  const textBytes: number[] = [];
  for (let i = 0; i < length; i++) textBytes.push(read(8));
  return {
    text: new TextDecoder().decode(Uint8Array.from(textBytes)),
    level,
    version,
    mask,
  };
}
