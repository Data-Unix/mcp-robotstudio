import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CookieStore } from "./client.js";

/**
 * Persists RWS session cookies in the OS temporary directory keyed by a SHA-256
 * hash of (baseUrl | username), matching scripts/rws_live_control.py so
 * successive CLI runs reuse the same controller session instead of exhausting
 * the 70-session limit ("Too many sessions 70/70").
 */
export class FileCookieStore implements CookieStore {
  private readonly dir: string;

  constructor(dir = os.tmpdir()) {
    this.dir = dir;
  }

  private filePath(key: string): string {
    const digest = crypto.createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
    return path.join(this.dir, `rws_session_${digest}.cookie`);
  }

  async load(key: string): Promise<string | undefined> {
    try {
      const value = await fs.readFile(this.filePath(key), "utf8");
      const trimmed = value.trim();
      return trimmed || undefined;
    } catch {
      return undefined;
    }
  }

  async save(key: string, cookieHeader: string): Promise<void> {
    try {
      await fs.writeFile(this.filePath(key), cookieHeader, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Best-effort persistence: in-memory cookie still works for the active process.
    }
  }
}
