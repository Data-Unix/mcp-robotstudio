import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import * as esbuild from "esbuild-wasm";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(EXTENSION_DIR, "public");
const DIST_DIR = path.join(EXTENSION_DIR, "dist");
const ICONS_DIR = path.join(DIST_DIR, "icons");
const ZIP_OUTPUT = path.join(EXTENSION_DIR, "mcp-robotstudio-rws-monitor.zip");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createRobotIconPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const border = Math.max(1, Math.floor(size / 8));
  const innerMin = Math.floor(size * 0.28);
  const innerMax = Math.ceil(size * 0.72);

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter None
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      const onOuterBorder =
        x < border || y < border || x >= size - border || y >= size - border;
      const onRing =
        x >= innerMin &&
        x < innerMax &&
        y >= innerMin &&
        y < innerMax &&
        (x === innerMin || x === innerMax - 1 || y === innerMin || y === innerMax - 1);

      if (onOuterBorder) {
        // #0284c7 sky-blue frame
        raw[px] = 2;
        raw[px + 1] = 132;
        raw[px + 2] = 199;
        raw[px + 3] = 255;
      } else if (onRing) {
        // #34d399 read-only green indicator
        raw[px] = 52;
        raw[px + 1] = 211;
        raw[px + 2] = 153;
        raw[px + 3] = 255;
      } else {
        // #0f172a slate background
        raw[px] = 15;
        raw[px + 1] = 23;
        raw[px + 2] = 42;
        raw[px + 3] = 255;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function collectDistFiles(dir, prefix = "") {
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, item.name);
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      entries.push(...collectDistFiles(full, rel));
    } else {
      entries.push({ rel, full });
    }
  }
  return entries;
}

function writeChromeWebStoreZip(distDir, zipPath) {
  const files = collectDistFiles(distDir);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { rel, full } of files) {
    const nameBuf = Buffer.from(rel, "utf8");
    const raw = fs.readFileSync(full);
    const deflated = zlib.deflateRawSync(raw);
    const checksum = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(8, 8); // DEFLATE
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x5421, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x5421, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    localParts.push(local, deflated);
    centralParts.push(central);
    offset += local.length + deflated.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([...localParts, centralDir, eocd]));
}

export async function buildExtension({ zip = false } = {}) {
  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(ICONS_DIR, { recursive: true });

  for (const file of fs.readdirSync(PUBLIC_DIR)) {
    const src = path.join(PUBLIC_DIR, file);
    const dst = path.join(DIST_DIR, file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, dst);
    }
  }

  for (const size of [16, 48, 128]) {
    fs.writeFileSync(path.join(ICONS_DIR, `icon${size}.png`), createRobotIconPng(size));
  }

  const preloadPath = path.join(EXTENSION_DIR, "esbuild-preload.cjs");
  const prevNodeOptions = process.env.NODE_OPTIONS;
  const requireFlag = preloadPath.includes(" ") ? `--require="${preloadPath}"` : `--require=${preloadPath}`;
  process.env.NODE_OPTIONS = prevNodeOptions ? `${prevNodeOptions} ${requireFlag}` : requireFlag;

  try {
    await esbuild.build({
      entryPoints: [
        path.join(EXTENSION_DIR, "src/background.ts"),
        path.join(EXTENSION_DIR, "src/panel.ts"),
        path.join(EXTENSION_DIR, "src/options.ts"),
      ],
      outdir: DIST_DIR,
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "chrome120",
      minify: false,
      sourcemap: false,
      logLevel: "silent",
    });
  } finally {
    if (prevNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = prevNodeOptions;
    }
    await esbuild.stop().catch(() => undefined);
  }

  if (zip) {
    writeChromeWebStoreZip(DIST_DIR, ZIP_OUTPUT);
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await buildExtension({ zip: process.argv.includes("--zip") });
}
