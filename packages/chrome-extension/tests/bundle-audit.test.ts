import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { LICENSE_PUBLIC_KEY } from "../src/license-public-key.js";

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(EXTENSION_DIR, "dist");
const PUBLIC_DIR = path.join(EXTENSION_DIR, "public");

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

const read = (f: string) => fs.readFileSync(path.join(DIST_DIR, f), "utf8");

describe("Chrome Extension MV3 security & bundle audit (dist/)", () => {
  beforeAll(() => {
    if (!fs.existsSync(path.join(DIST_DIR, "offscreen.js"))) {
      execFileSync(process.execPath, [path.join(EXTENSION_DIR, "build.mjs")], { stdio: "pipe" });
    }
  });

  it("enforces least-privilege Manifest V3 metadata with a strict CSP", () => {
    const manifest = JSON.parse(read("manifest.json")) as Record<string, unknown>;
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.permissions).toEqual(["storage", "sidePanel", "offscreen"]);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
    expect(manifest.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
    const csp = (manifest.content_security_policy as { extension_pages: string }).extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:/);
  });

  it("ships offscreen.js and rspag-worker.js compiled, and no unexpected code files", () => {
    const codeFiles = listFilesRecursive(DIST_DIR).filter((f) => /\.(js|html|css)$/i.test(f)).map((f) => path.basename(f)).sort();
    expect(codeFiles).toEqual(["background.js", "offscreen.html", "offscreen.js", "options.html", "options.js", "panel.html", "panel.js", "rspag-worker.js", "styles.css"]);
    for (const js of ["background.js", "panel.js", "options.js", "offscreen.js", "rspag-worker.js"]) {
      execFileSync(process.execPath, ["--check", path.join(DIST_DIR, js)], { stdio: "pipe" });
    }
    expect(read("offscreen.html")).toContain('<script type="module" src="offscreen.js"></script>');
    expect(read("offscreen.js")).toContain("DOMParser");
    expect(read("offscreen.js")).toMatch(/robapi2_subscription/);
    expect(read("rspag-worker.js")).toContain('new DecompressionStream("deflate-raw")');
    expect(read("background.js")).toContain("chrome.offscreen.Reason.DOM_PARSER");
    const knowledge = JSON.parse(read("knowledge.json")) as { checklist: unknown[]; incidents: unknown[] };
    if (fs.existsSync(path.join(EXTENSION_DIR, "../../metodologia"))) {
      expect(knowledge.checklist.length).toBeGreaterThan(3);
    }
  });

  it("contains zero remote code, zero unsafe DOM/eval sinks and zero emojis", () => {
    const files = listFilesRecursive(DIST_DIR).filter((f) => /\.(js|html|css|json)$/i.test(f));
    const sources = [...files, ...listFilesRecursive(PUBLIC_DIR).filter((f) => /\.html$/.test(f))];
    const forbidden: Array<[string, RegExp]> = [
      ["eval(", /\beval\s*\(/],
      ["new Function", /\bnew\s+Function\s*\(/],
      ["setTimeout string", /\bsetTimeout\s*\(\s*["'`]/],
      ["setInterval string", /\bsetInterval\s*\(\s*["'`]/],
      ["innerHTML", /\.innerHTML\b/],
      ["outerHTML", /\.outerHTML\b/],
      ["insertAdjacentHTML", /\.insertAdjacentHTML\s*\(/],
      ["document.write", /\bdocument\.write(?:ln)?\s*\(/],
      ["remote script tag", /<script[^>]+src=["']https?:/i],
      ["importScripts", /\bimportScripts\s*\(/],
      ["remote import", /\bimport\s*\(\s*["'`]https?:/],
      ["inline script", /<script(?![^>]*\bsrc=)[^>]*>/i],
      ["inline handler", /\son[a-z]+\s*=\s*["']/i],
    ];
    const urlRegex = /https?:\/\/[^\s"'`)\\]+/gi;
    for (const filePath of sources) {
      const content = fs.readFileSync(filePath, "utf8");
      const rel = path.relative(EXTENSION_DIR, filePath);
      for (const [label, regex] of forbidden) {
        if (label.startsWith("inline") && !/\.html$/.test(filePath)) continue;
        expect(regex.test(content), `Forbidden pattern ${label} found in ${rel}`).toBe(false);
      }
      expect(content.match(/\p{Extended_Pictographic}/gu) ?? [], `emoji in ${rel}`).toEqual([]);
      if (path.basename(filePath) === "manifest.json") continue; // host patterns, checked above
      for (const foundUrl of content.match(urlRegex) ?? []) {
        const allowed = /^https?:\/\/(127\.0\.0\.1|localhost|\$\{)/.test(foundUrl) || foundUrl === "http://www.w3.org/1999/xhtml";
        expect(allowed, `Unexpected external URL "${foundUrl}" in ${rel}`).toBe(true);
      }
    }
  });

  it("keeps every RWS write in background.js (license + session write mode gate)", () => {
    const writeMethods = ["writeRapidSymbol(", "setSignal(", "loadModule(", "startRapid(", "stopRapid(", "setSpeedRatio(", "triggerBackup(", "resetProgramPointer("];
    for (const f of ["panel.js", "options.js", "offscreen.js", "rspag-worker.js"]) {
      const t = read(f);
      for (const m of writeMethods) expect(t.includes(m), `${m} in ${f}`).toBe(false);
    }
    const bg = read("background.js");
    for (const m of ["writeRapidSymbol(", "loadModule(", "setSpeedRatio(", "triggerBackup("]) expect(bg).toContain(m);
    // tolerant of the store build (minified whitespace)
    expect(bg).toMatch(/PRO_WRITE_ACTIONS\.has\(req\.action\)\s*&&\s*!\s*\(?\s*await\s+loadWriteMode\(\)\)?/);
    // RwsClient methods are bundled, but the extension never calls motion commands
    expect(bg).not.toMatch(/\.(startRapid|stopRapid|resetProgramPointer)\(/);
  });

  it("free plan vs PRO: every PRO card is tagged with a known feature", async () => {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, "panel.html"), "utf8");
    const { PRO_FEATURES } = await import("../src/license.js");
    const tagged = [...html.matchAll(/data-feature="(\w+)"/g)].map((m) => m[1]!);
    expect(tagged.length).toBeGreaterThanOrEqual(14);
    for (const f of tagged) expect(Object.keys(PRO_FEATURES)).toContain(f);
    expect([...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual([
      "01 TELEMETRIA Y CINEMATICA",
      "02 FORENSE Y DIFF",
      "03 OSCILOSCOPIO Y FLOTA",
      "04 ALCANCE Y RECETAS",
      "05 ESTUDIO DE PRACTICAS",
    ]);
  });

  it("embeds the committed public license key (never a private key)", () => {
    const bg = read("background.js");
    expect(bg).toContain(LICENSE_PUBLIC_KEY.x!);
    for (const f of listFilesRecursive(DIST_DIR)) expect(fs.readFileSync(f, "latin1")).not.toMatch(/"d"\s*:\s*"/);
    expect(fs.existsSync(path.join(EXTENSION_DIR, "src", "license-public-key.ts"))).toBe(true);
  });
});

describe("store knowledge (zip) carries no agent memory or internal paths", () => {
  it("keeps the checklist, drops incidents/topics and repository paths", async () => {
    // @ts-expect-error plain .mjs build script without types
    const { buildKnowledge, storeKnowledge } = await import("../build.mjs");
    const full = buildKnowledge() as { checklist: Array<{ items: string[] }>; incidents: unknown[] };
    const store = storeKnowledge(full) as { checklist: Array<{ items: string[] }>; incidents: unknown[]; topics: unknown[] };
    expect(store.incidents).toEqual([]);
    expect(store.topics).toEqual([]);
    const text = JSON.stringify(store);
    expect(text).not.toMatch(/agentes\/|memoria|scripts\/|NO_SUBIR|claude|anthropic/i);
    if (full.checklist.length) expect(store.checklist.flatMap((s) => s.items).length).toBeGreaterThan(10);
  });
});

describe("lockstep version with the npm package", () => {
  it("ships dist/manifest.json with the same version as every package.json and the source manifest", () => {
    const packagesDir = path.resolve(EXTENSION_DIR, "..");
    const versionOf = (rel: string): unknown => (JSON.parse(fs.readFileSync(path.join(packagesDir, rel), "utf8")) as { version?: unknown }).version;
    const files = ["package.json", "mcp-robotstudio/package.json", "chrome-extension/package.json", "chrome-extension/public/manifest.json", "chrome-extension/dist/manifest.json"];
    const expected = versionOf("mcp-robotstudio/package.json");
    expect(expected).toBe("0.2.0");
    expect(Object.fromEntries(files.map((f) => [f, versionOf(f)]))).toEqual(Object.fromEntries(files.map((f) => [f, expected])));
  });
});
