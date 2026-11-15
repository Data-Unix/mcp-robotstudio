import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Granular write scopes. Default is read-only (no mutating tool is registered).
 * --allow-write is kept as an alias that enables all four scopes.
 */
export type PermissionScope = "io-write" | "var-write" | "module-upload" | "motion";
export const ALL_SCOPES: readonly PermissionScope[] = ["io-write", "var-write", "module-upload", "motion"];

export const SCOPE_FLAGS: Record<PermissionScope, string> = {
  "io-write": "--allow-io-write",
  "var-write": "--allow-var-write",
  "module-upload": "--allow-module-upload",
  motion: "--allow-motion",
};

export function scopesFromFlags(flags: Partial<Record<PermissionScope | "all", boolean>>): Set<PermissionScope> {
  if (flags.all) return new Set(ALL_SCOPES);
  return new Set(ALL_SCOPES.filter((s) => flags[s]));
}

const SECRET_KEYS = /pass(word)?|secret|token|authorization|cookie/i;

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[REDACTED]" : redact(v)]),
    );
  }
  if (typeof value === "string" && value.length > 2000) return `${value.slice(0, 2000)}...[${value.length} chars]`;
  return value;
}

export interface AuditRecord {
  ts: string;
  seq: number;
  tool: string;
  agent: string;
  rwsUser: string;
  scope: PermissionScope | "read";
  params: unknown;
  outcome: "ok" | "error" | "denied";
  result: unknown;
  prev: string;
  hash: string;
}

/**
 * Append-only JSONL audit log. Each line carries the SHA-256 of the previous
 * line (`prev`) and of itself (`hash`), so editing or deleting a past line
 * breaks the chain (verifyAuditLog). The file is only ever opened with "a".
 */
export class AuditLog {
  private prev = "0".repeat(64);
  private seq = 0;

  constructor(
    readonly filePath: string | undefined,
    readonly agent = "mcp-client",
    readonly rwsUser = "unknown",
  ) {
    if (filePath && fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        const rec = JSON.parse(last) as AuditRecord;
        this.prev = rec.hash;
        this.seq = rec.seq;
      }
    }
  }

  record(entry: { tool: string; scope: AuditRecord["scope"]; params: unknown; outcome: AuditRecord["outcome"]; result: unknown }): AuditRecord {
    const body = {
      ts: new Date().toISOString(),
      seq: ++this.seq,
      tool: entry.tool,
      agent: this.agent,
      rwsUser: this.rwsUser,
      scope: entry.scope,
      params: redact(entry.params),
      outcome: entry.outcome,
      result: redact(entry.result),
      prev: this.prev,
    };
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const rec: AuditRecord = { ...body, hash };
    this.prev = hash;
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(rec)}\n`, { encoding: "utf8", flag: "a" });
    }
    return rec;
  }
}

export function verifyAuditLog(filePath: string): { ok: boolean; records: number; brokenAt?: number } {
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
  let prev = "0".repeat(64);
  for (let i = 0; i < lines.length; i++) {
    const rec = JSON.parse(lines[i]!) as AuditRecord;
    const { hash, ...body } = rec;
    const calc = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    if (rec.prev !== prev || calc !== hash) return { ok: false, records: lines.length, brokenAt: i + 1 };
    prev = hash;
  }
  return { ok: true, records: lines.length };
}
