/**
 * Web Worker for .rspag files: audit (free) and anonymize + re-pack + clean
 * Preview.png (PRO, the panel checks the licence before posting the job).
 * Uses the bundled zip/audit code from mcp-robotstudio and the browser's own
 * CompressionStream, so no third-party or remote code runs.
 */
import { anonymizeRspag, auditRspag } from "mcp-robotstudio/rspag";
import type { Codec } from "mcp-robotstudio/rspag/zip";

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export const browserCodec: Codec = {
  inflateRaw: (d) => pipe(d, new DecompressionStream("deflate-raw")),
  deflateRaw: (d) => pipe(d, new CompressionStream("deflate-raw")),
};

interface Job {
  id: number;
  op: "audit" | "anonymize";
  buffer: ArrayBuffer;
  blocklist?: string[];
}

self.onmessage = async (ev: MessageEvent<Job>) => {
  const { id, op, buffer, blocklist } = ev.data;
  try {
    const buf = new Uint8Array(buffer);
    if (op === "audit") {
      self.postMessage({ id, ok: true, report: await auditRspag(buf, browserCodec, { blocklist }) });
      return;
    }
    const an = await anonymizeRspag(buf, browserCodec, { blocklist });
    const report = await auditRspag(an.data, browserCodec, { blocklist });
    const preview = an.preview?.slice();
    const transfer = [an.data.buffer, ...(preview ? [preview.buffer] : [])] as Transferable[];
    self.postMessage({ id, ok: true, report, changedEntries: an.changedEntries, data: an.data, preview }, { transfer });
  } catch (e) {
    self.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
