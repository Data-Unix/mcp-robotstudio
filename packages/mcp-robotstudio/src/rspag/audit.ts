/**
 * Audit and anonymize RobotStudio Pack&Go (.rspag) files, aligned with
 * scripts/anonymize_rspag.py and the 0x800706BA incident
 * (agentes/memoria/incidentes/2026-11-14-packgo-datos-personales.md):
 *  - system.guid / template.guid present and well formed per controller;
 *  - backup taken from a folder copy (project name in rw6system.xml paths does
 *    not match the .rsproj name) -> restore may fail with 0x800706BA;
 *  - personal data: C:\Users\<name>\ paths, e-mails, extra blocklist terms;
 *  - Preview.png metadata chunks (tEXt/zTXt/iTXt/eXIf).
 * Binary entries are never patched; text entries keep their encoding.
 */
import { type Codec, crc32, entryData, readZip, writeZip, type ZipEntry, type ZipWriteItem } from "./zip.js";

const BINARY_EXT = /\.(png|jpe?g|gif|bmp|ico|rlf|dll|exe|bin|guid|zip)$/i;
const TEXT_EXT = /\.(xml|txt|cfg|rsuser|rsproj|id|mod|prg|sys|rsf|log|ini|json)$/i;
const NESTED_ZIP_EXT = /\.rsstnx$/i;

export const DEFAULT_ALLOWED_USERS = ["usuario", "public", "default", "default user", "all users"];

export interface PrivacyFinding {
  entry: string;
  kind: "user-path" | "email" | "blocklist";
  match: string;
}

export interface ControllerAudit {
  name: string;
  systemGuid: string | null;
  templateGuid: string | null;
  guidsWellFormed: boolean;
  hasHome: boolean;
  backupProjectName: string | null;
  issues: string[];
}

export interface PngMetadataReport {
  entry: string;
  chunks: string[];
  metadataChunks: string[];
}

export interface RspagAudit {
  entries: number;
  projectName: string | null;
  controllers: ControllerAudit[];
  privacy: PrivacyFinding[];
  pngs: PngMetadataReport[];
  crcErrors: string[];
  issues: string[];
  verdict: "ok" | "warnings" | "fail";
}

export interface AuditOptions {
  allowedUsers?: string[];
  blocklist?: string[];
}

const GUID_RE = /^\{?[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}?$/i;

type TextEncoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "latin1";

export function decodeText(data: Uint8Array): { text: string; encoding: TextEncoding } {
  if (data[0] === 0xff && data[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(data.subarray(2)), encoding: "utf-16le" };
  if (data[0] === 0xfe && data[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(data.subarray(2)), encoding: "utf-16be" };
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return { text: new TextDecoder("utf-8").decode(data.subarray(3)), encoding: "utf-8-bom" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(data), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("latin1").decode(data), encoding: "latin1" };
  }
}

export function encodeText(text: string, encoding: TextEncoding): Uint8Array {
  if (encoding === "utf-8") return new TextEncoder().encode(text);
  if (encoding === "utf-8-bom") return new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
  if (encoding === "latin1") return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
  const out = new Uint8Array(2 + text.length * 2);
  const le = encoding === "utf-16le";
  out[0] = le ? 0xff : 0xfe;
  out[1] = le ? 0xfe : 0xff;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = le ? c & 0xff : c >> 8;
    out[3 + i * 2] = le ? c >> 8 : c & 0xff;
  }
  return out;
}

const USER_PATH_RE = /([A-Za-z]:[\\/]+Users[\\/]+)([^\\/"'<>\r\n]+)([\\/])/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function isText(name: string): boolean {
  return !BINARY_EXT.test(name) && (TEXT_EXT.test(name) || !/\.[^/]+$/.test(name.split("/").pop() ?? ""));
}

export function scanText(entry: string, text: string, opts: AuditOptions = {}): PrivacyFinding[] {
  const allowed = new Set((opts.allowedUsers ?? DEFAULT_ALLOWED_USERS).map((s) => s.toLowerCase()));
  const out: PrivacyFinding[] = [];
  for (const m of text.matchAll(USER_PATH_RE)) {
    if (!allowed.has(m[2]!.toLowerCase())) out.push({ entry, kind: "user-path", match: m[0] });
  }
  for (const m of text.matchAll(EMAIL_RE)) out.push({ entry, kind: "email", match: m[0] });
  for (const term of opts.blocklist ?? []) {
    if (term && text.toLowerCase().includes(term.toLowerCase())) out.push({ entry, kind: "blocklist", match: term });
  }
  return out;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_METADATA = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME"]);

export function pngChunks(png: Uint8Array): string[] {
  if (!PNG_SIG.every((b, i) => png[i] === b)) throw new Error("not a PNG file");
  const out: string[] = [];
  let p = 8;
  while (p + 8 <= png.length) {
    const len = (png[p]! << 24) | (png[p + 1]! << 16) | (png[p + 2]! << 8) | png[p + 3]!;
    out.push(String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!));
    p += 12 + (len >>> 0);
  }
  return out;
}

/** Keeps only IHDR, PLTE (palette images), tRNS, IDAT and IEND. */
export function stripPngMetadata(png: Uint8Array): Uint8Array {
  if (!PNG_SIG.every((b, i) => png[i] === b)) throw new Error("not a PNG file");
  const keep = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let p = 8;
  while (p + 8 <= png.length) {
    const len = ((png[p]! << 24) | (png[p + 1]! << 16) | (png[p + 2]! << 8) | png[p + 3]!) >>> 0;
    const type = String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!);
    if (keep.has(type)) parts.push(png.subarray(p, p + 12 + len));
    p += 12 + len;
  }
  const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

export async function auditRspag(buf: Uint8Array, codec: Codec, opts: AuditOptions = {}): Promise<RspagAudit> {
  const entries = readZip(buf);
  const privacy: PrivacyFinding[] = [];
  const pngs: PngMetadataReport[] = [];
  const crcErrors: string[] = [];
  const issues: string[] = [];
  const texts = new Map<string, string>();

  const visit = async (list: ZipEntry[], prefix: string) => {
    for (const e of list) {
      if (e.isDir) continue;
      const full = prefix + e.name;
      const data = await entryData(e, codec);
      if (crc32(data) !== e.crc) crcErrors.push(full);
      if (NESTED_ZIP_EXT.test(e.name)) {
        try {
          await visit(readZip(data), `${full}!/`);
        } catch {
          const { text } = decodeText(data);
          privacy.push(...scanText(full, text, opts));
        }
      } else if (/\.png$/i.test(e.name)) {
        const chunks = pngChunks(data);
        pngs.push({ entry: full, chunks, metadataChunks: chunks.filter((c) => PNG_METADATA.has(c)) });
      } else if (isText(e.name)) {
        const { text } = decodeText(data);
        texts.set(full, text);
        privacy.push(...scanText(full, text, opts));
      }
    }
  };
  await visit(entries, "");

  const projectName = entries.find((e) => /^[^/]+\.rsproj$/i.test(e.name))?.name.replace(/\.rsproj$/i, "") ?? null;
  const ctrlNames = new Set<string>();
  for (const e of entries) {
    const m = /^Controller Data\/([^/]+)\//.exec(e.name);
    if (m) ctrlNames.add(m[1]!);
  }
  const controllers: ControllerAudit[] = [];
  for (const name of ctrlNames) {
    const base = `Controller Data/${name}/`;
    const read = (p: string) => texts.get(base + p) ?? null;
    const guidOf = async (p: string) => {
      const e = entries.find((x) => x.name === base + p);
      return e ? decodeText(await entryData(e, codec)).text.trim() : null;
    };
    const systemGuid = await guidOf("BACKINFO/system.guid");
    const templateGuid = await guidOf("BACKINFO/template.guid");
    const cIssues: string[] = [];
    if (!systemGuid) cIssues.push("BACKINFO/system.guid missing");
    if (!templateGuid) cIssues.push("BACKINFO/template.guid missing");
    const wellFormed = Boolean(systemGuid && templateGuid && GUID_RE.test(systemGuid) && GUID_RE.test(templateGuid));
    if (systemGuid && templateGuid && !wellFormed) cIssues.push("system.guid/template.guid are not valid GUIDs");
    const rw6 = read("BACKINFO/rw6system.xml") ?? "";
    const backupProjectName = /Proyectos RobotStudio[\\/]+([^\\/]+)[\\/]+Virtual Controllers/i.exec(rw6)?.[1] ??
      /[\\/]([^\\/]+)[\\/]+Virtual Controllers[\\/]/i.exec(rw6)?.[1] ?? null;
    if (projectName && backupProjectName && backupProjectName !== projectName) {
      cIssues.push(
        `backup was taken in project "${backupProjectName}" but the package is "${projectName}": restore may fail with 0x800706BA (regenerate the Pack&Go from the live station)`,
      );
    }
    const hasHome = entries.some((e) => e.name.startsWith(`${base}HOME/`));
    if (!hasHome) cIssues.push("HOME directory missing in controller backup");
    controllers.push({ name, systemGuid, templateGuid, guidsWellFormed: wellFormed, hasHome, backupProjectName, issues: cIssues });
  }
  if (controllers.length === 0) issues.push("no Controller Data/<controller>/ backup inside the package");
  if (crcErrors.length) issues.push(`CRC mismatch in ${crcErrors.length} entries`);
  if (privacy.length) issues.push(`${privacy.length} personal-data findings`);
  const pngMeta = pngs.filter((p) => p.metadataChunks.length > 0);
  if (pngMeta.length) issues.push(`PNG metadata chunks in ${pngMeta.map((p) => p.entry).join(", ")}`);
  for (const c of controllers) issues.push(...c.issues.map((i) => `${c.name}: ${i}`));

  const fail = crcErrors.length > 0 || privacy.length > 0 || controllers.some((c) => !c.guidsWellFormed);
  return {
    entries: entries.length,
    projectName,
    controllers,
    privacy,
    pngs,
    crcErrors,
    issues,
    verdict: fail ? "fail" : issues.length ? "warnings" : "ok",
  };
}

export interface AnonymizeResult {
  data: Uint8Array;
  changedEntries: string[];
  preview?: Uint8Array;
}

/** Rewrites C:\Users\<name>\ to C:\Users\<replacement>\ in text entries and strips PNG metadata. */
export async function anonymizeRspag(
  buf: Uint8Array,
  codec: Codec,
  opts: AuditOptions & { replacement?: string } = {},
): Promise<AnonymizeResult> {
  const replacement = opts.replacement ?? "usuario";
  const allowed = new Set((opts.allowedUsers ?? DEFAULT_ALLOWED_USERS).map((s) => s.toLowerCase()));
  const changedEntries: string[] = [];
  let preview: Uint8Array | undefined;

  const repack = async (zip: Uint8Array, prefix: string): Promise<Uint8Array> => {
    const items: ZipWriteItem[] = [];
    for (const e of readZip(zip)) {
      if (e.isDir) {
        items.push({ name: e.name, original: e });
        continue;
      }
      const data = await entryData(e, codec);
      let next: Uint8Array | undefined;
      if (NESTED_ZIP_EXT.test(e.name)) {
        try {
          const inner = await repack(data, `${prefix}${e.name}!/`);
          if (changedEntries.some((c) => c.startsWith(`${prefix}${e.name}!/`))) next = inner;
        } catch {
          // not a zip: treat as text below
        }
      } else if (/\.png$/i.test(e.name)) {
        if (pngChunks(data).some((c) => PNG_METADATA.has(c))) next = stripPngMetadata(data);
        if (/^Preview\.png$/i.test(prefix + e.name) || /(^|\/)Preview\.png$/i.test(e.name)) preview ??= next ?? data;
      } else if (isText(e.name)) {
        const { text, encoding } = decodeText(data);
        let out = text.replace(USER_PATH_RE, (all, pre: string, user: string, sep: string) =>
          allowed.has(user.toLowerCase()) ? all : `${pre}${replacement}${sep}`,
        );
        for (const term of opts.blocklist ?? []) {
          if (term) out = out.split(term).join(replacement);
        }
        if (out !== text) next = encodeText(out, encoding);
      }
      if (next) changedEntries.push(prefix + e.name);
      items.push(next ? { name: e.name, data: next } : { name: e.name, original: e });
    }
    return await writeZip(items, codec);
  };

  const data = await repack(buf, "");
  return { data, changedEntries, ...(preview ? { preview } : {}) };
}
