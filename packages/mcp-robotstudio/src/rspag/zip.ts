/**
 * Minimal ZIP reader/writer (stored + deflate) that runs in Node and in a
 * browser Web Worker. Inflate/deflate are injected so the module has no
 * platform imports. Unchanged entries are copied with their original
 * compressed bytes and CRC, so binary entries (key.id, *.rlf, streams) stay
 * byte-identical after re-packing.
 */
export interface Codec {
  inflateRaw(data: Uint8Array): Promise<Uint8Array>;
  deflateRaw(data: Uint8Array): Promise<Uint8Array>;
}

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  flags: number;
  /** raw compressed bytes */
  raw: Uint8Array;
  isDir: boolean;
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function readZip(buf: Uint8Array): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file (end of central directory not found)");
  const count = u16(buf, eocd + 10);
  let p = u32(buf, eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (u32(buf, p) !== 0x02014b50) throw new Error(`corrupt central directory at ${p}`);
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const crc = u32(buf, p + 16);
    const compressedSize = u32(buf, p + 20);
    const size = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localOffset = u32(buf, p + 42);
    const name = new TextDecoder(flags & 0x0800 ? "utf-8" : "latin1").decode(buf.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = u16(buf, localOffset + 26);
    const lExtraLen = u16(buf, localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    entries.push({
      name,
      method,
      crc,
      compressedSize,
      size,
      flags,
      raw: buf.subarray(dataStart, dataStart + compressedSize),
      isDir: name.endsWith("/"),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function entryData(e: ZipEntry, codec: Codec): Promise<Uint8Array> {
  if (e.method === 0) return e.raw;
  if (e.method === 8) return await codec.inflateRaw(e.raw);
  throw new Error(`unsupported compression method ${e.method} in ${e.name}`);
}

export interface ZipWriteItem {
  name: string;
  /** original entry to copy byte-for-byte (when data is undefined) */
  original?: ZipEntry;
  /** new content (re-compressed with deflate unless store) */
  data?: Uint8Array;
}

export async function writeZip(items: ZipWriteItem[], codec: Codec): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const it of items) {
    let method: number;
    let crc: number;
    let size: number;
    let raw: Uint8Array;
    if (it.data === undefined && it.original) {
      ({ method, crc, size, raw } = it.original);
    } else {
      const data = it.data ?? new Uint8Array();
      crc = crc32(data);
      size = data.length;
      if (it.name.endsWith("/") || data.length === 0) {
        method = 0;
        raw = data;
      } else {
        method = 8;
        raw = await codec.deflateRaw(data);
      }
    }
    const name = enc.encode(it.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, raw.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, raw.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, raw);
    centrals.push(central);
    offset += local.length + raw.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, items.length, true);
  ev.setUint16(10, items.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
