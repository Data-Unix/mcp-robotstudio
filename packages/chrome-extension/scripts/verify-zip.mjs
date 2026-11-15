// Verifies the Chrome Web Store package before upload.
//   node scripts/verify-zip.mjs [path/to/mcp-robotstudio-rws-monitor.zip]
// Exit 1 on any finding. Read-only; uses the zip reader of mcp-robotstudio.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { pngChunks } from "mcp-robotstudio/rspag";
import { readZip } from "mcp-robotstudio/rspag/zip";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const zipPath = process.argv[2] ?? path.join(HERE, "mcp-robotstudio-rws-monitor.zip");
const expectedVersion = JSON.parse(fs.readFileSync(path.join(HERE, "..", "mcp-robotstudio", "package.json"), "utf8")).version;

const REQUIRED = [
  "manifest.json", "background.js", "panel.html", "panel.js", "options.html", "options.js",
  "offscreen.html", "offscreen.js", "rspag-worker.js", "styles.css", "knowledge.json",
  "icons/icon16.png", "icons/icon48.png", "icons/icon128.png",
];
const findings = [];
const ok = [];
const entries = readZip(new Uint8Array(fs.readFileSync(zipPath))).filter((e) => !e.isDir);
const files = new Map(entries.map((e) => [e.name, e.method === 8 ? zlib.inflateRawSync(e.raw) : Buffer.from(e.raw)]));

for (const r of REQUIRED) (files.has(r) ? ok : findings).push(`required ${r}`);
for (const name of files.keys()) if (!REQUIRED.includes(name)) findings.push(`unexpected file ${name}`);

const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
(manifest.version === expectedVersion ? ok : findings).push(`manifest version ${manifest.version} (expected ${expectedVersion})`);
(manifest.manifest_version === 3 ? ok : findings).push("manifest_version 3");
const csp = manifest.content_security_policy?.extension_pages ?? "";
(/script-src 'self'/.test(csp) && !/unsafe|https?:/.test(csp) ? ok : findings).push(`CSP ${csp}`);

const TEXT_CHECKS = [
  ["emoji", /\p{Extended_Pictographic}/u],
  ["remote URL", /https?:\/\/(?!127\.0\.0\.1|localhost|\$\{|www\.w3\.org\/1999\/xhtml)[a-z0-9.-]+\.[a-z]{2,}/i],
  ["private JWK (d)", /"d"\s*:\s*"/],
  ["Windows user path", /[A-Za-z]:\\{1,2}Users\\{1,2}(?!<|usuario\\)[^\\"'\s]+/],
  ["e-mail", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
  ["AI tooling trace", /\b(impeccable|anthropic|claude|chatgpt|openai|codex|copilot|cursor ai|CLAUDE\.md|AGENTS\.md|agentes\/memoria|deslop)\b/i],
  ["eval / remote code", /\beval\s*\(|new\s+Function\s*\(|importScripts\s*\(/],
];
for (const [name, buf] of files) {
  if (!/\.(js|html|css|json)$/.test(name)) continue;
  const text = buf.toString("utf8");
  for (const [label, re] of TEXT_CHECKS) {
    const m = re.exec(text);
    if (m) findings.push(`${label} in ${name}: "${m[0].slice(0, 60)}"`);
  }
  if (/\.(css)$/.test(name) && /\/\*/.test(text)) findings.push(`comment in ${name}`);
  if (/\.html$/.test(name) && /<!--/.test(text)) findings.push(`comment in ${name}`);
}

// JS must parse and carry no line comments left by the build
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rs-zipcheck-"));
fs.writeFileSync(path.join(tmp, "package.json"), '{"type":"module"}');
for (const [name, buf] of files) {
  if (!name.endsWith(".js")) continue;
  const p = path.join(tmp, path.basename(name));
  fs.writeFileSync(p, buf);
  try {
    execFileSync(process.execPath, ["--check", p], { stdio: "pipe" });
    ok.push(`node --check ${name}`);
  } catch (e) {
    findings.push(`syntax ${name}: ${String(e.stderr).slice(0, 120)}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

for (const [name, buf] of files) {
  if (!name.endsWith(".png")) continue;
  const extra = pngChunks(new Uint8Array(buf)).filter((c) => !["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(c));
  (extra.length ? findings : ok).push(`png ${name}${extra.length ? ` metadata ${extra.join(",")}` : ""}`);
}

console.log(`zip: ${zipPath} (${fs.statSync(zipPath).size} bytes, ${files.size} files)`);
for (const o of ok) console.log(`  ok   ${o}`);
for (const f of findings) console.log(`  FAIL ${f}`);
console.log(findings.length ? `ZIP CHECK FAILED (${findings.length})` : "ZIP CHECK OK");
process.exit(findings.length ? 1 : 0);
