import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(EXTENSION_DIR, "dist");

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("Chrome Extension MV3 security & bundle audit (dist/)", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(EXTENSION_DIR, "build.mjs")], {
      stdio: "pipe",
    });
  });

  it("enforces strict least-privilege Manifest V3 metadata", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(DIST_DIR, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.permissions).toEqual(["storage", "sidePanel"]);
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
    expect(manifest.optional_host_permissions).toEqual(["http://*/*"]);

    const csp = (manifest.content_security_policy as { extension_pages: string }).extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("contains zero remote code, zero unsafe DOM/eval sinks, and zero write endpoints in dist/", () => {
    const files = listFilesRecursive(DIST_DIR);
    const codeFiles = files.filter((f) => /\.(js|html|css)$/i.test(f));
    expect(codeFiles.map((f) => path.basename(f)).sort()).toEqual([
      "background.js",
      "options.html",
      "options.js",
      "panel.html",
      "panel.js",
      "styles.css",
    ]);

    const forbiddenPatterns: Array<[string, RegExp]> = [
      ["eval(", /\beval\s*\(/],
      ["new Function", /\bnew\s+Function\s*\(/],
      ["setTimeout string", /\bsetTimeout\s*\(\s*["'`]/],
      ["setInterval string", /\bsetInterval\s*\(\s*["'`]/],
      ["innerHTML", /\.innerHTML\b/],
      ["outerHTML", /\.outerHTML\b/],
      ["insertAdjacentHTML", /\.insertAdjacentHTML\s*\(/],
      ["document.write", /\bdocument\.write(?:ln)?\s*\(/],
      ["remote script tag", /<script[^>]+src=["']https?:/i],
      ["RWS write action=set", /action=set\b/],
      ["RWS action=start", /action=start\b/],
      ["RWS action=stop", /action=stop\b/],
      ["RWS action=loadmod", /action=loadmod\b/],
      ["RWS fileservice PUT path", /\/fileservice\//],
      ["MCP write_rapid_symbol", /\bwrite_rapid_symbol\b/],
      ["MCP start_rapid", /\bstart_rapid\b/],
      ["MCP stop_rapid", /\bstop_rapid\b/],
      ["MCP load_module", /\bload_module\b/],
    ];

    const urlRegex = /https?:\/\/[^\s"'`)\\]+/gi;

    for (const filePath of codeFiles) {
      const content = fs.readFileSync(filePath, "utf8");
      const rel = path.relative(DIST_DIR, filePath);

      for (const [label, regex] of forbiddenPatterns) {
        expect(regex.test(content), `Forbidden pattern ${label} found in ${rel}`).toBe(false);
      }

      const urls = content.match(urlRegex) ?? [];
      for (const foundUrl of urls) {
        const isAllowedLocal =
          foundUrl.startsWith("http://127.0.0.1") ||
          foundUrl.startsWith("http://localhost") ||
          foundUrl.startsWith("http://${");
        expect(
          isAllowedLocal,
          `Unexpected external URL "${foundUrl}" found in ${rel}`,
        ).toBe(true);
      }
    }
  });
});
