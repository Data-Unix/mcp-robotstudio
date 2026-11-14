/**
 * Pure TypeScript MD5 implementation (RFC 1321) over UTF-8 strings.
 * Works identically in Node.js and browser Extension Service Workers
 * (where WebCrypto SubtleCrypto does not provide MD5).
 */

const SHIFT_AMOUNTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

const K_TABLE = Array.from({ length: 64 }, (_, i) =>
  Math.floor(0x1_0000_0000 * Math.abs(Math.sin(i + 1))) >>> 0,
);

function rotl32(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function toHexLE(word: number): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    const byte = (word >>> (i * 8)) & 0xff;
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;

  // Pad to 56 bytes mod 64, plus 8 bytes for 64-bit little-endian length.
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const lowBits = bitLen >>> 0;
  const highBits = Math.floor(bitLen / 0x1_0000_0000) >>> 0;
  view.setUint32(paddedLen - 8, lowBits, true);
  view.setUint32(paddedLen - 4, highBits, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Uint32Array(16);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let j = 0; j < 16; j++) {
      words[j] = view.getUint32(offset + j * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      const k = K_TABLE[i] ?? 0;
      const shift = SHIFT_AMOUNTS[i] ?? 0;
      const word = words[g] ?? 0;
      const temp = (f + a + k + word) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl32(temp, shift)) >>> 0;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}
