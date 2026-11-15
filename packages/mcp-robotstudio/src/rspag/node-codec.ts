import zlib from "node:zlib";
import type { Codec } from "./zip.js";

/** Node codec (zlib). Browser workers use CompressionStream instead. */
export async function nodeCodec(): Promise<Codec> {
  return {
    inflateRaw: async (d) => new Uint8Array(zlib.inflateRawSync(d)),
    deflateRaw: async (d) => new Uint8Array(zlib.deflateRawSync(d)),
  };
}
