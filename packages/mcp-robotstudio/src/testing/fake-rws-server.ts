import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { md5 } from "../rws/md5.js";

export interface FixtureRecord {
  request: string;
  status: number;
  headers: Record<string, string>;
  note: string;
  body: string;
}

export interface FakeRwsServerOptions {
  fixturesDir?: string;
  username?: string;
  password?: string;
  maxSessions?: number;
  authMode?: "digest" | "basic";
}

interface ExtraEvent {
  code: string;
  msgtype: string;
  src: string;
  tstamp: string;
  title: string;
  desc: string;
}

const DEFAULT_FIXTURE_FILES = [
  "00-challenge-sin-credenciales.json",
  "01-system.json",
  "02-panel-ctrlstate.json",
  "03-panel-opmode.json",
  "04-rapid-execution.json",
  "05-rapid-tasks.json",
  "06-rapid-modules-rw6.json",
  "07-rapid-modules-ruta-rw7-404.json",
  "08-symbol-tool0.json",
  "09-symbol-no-existe.json",
  "10-signals-pagina.json",
  "11-signal-por-nombre.json",
  "12-elog-dominio0.json",
  "13-jointtarget.json",
  "14-robtarget-tool0-wobj0.json",
  "15-mastership.json",
] as const;

export function findDefaultFixturesDir(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(current, "referencias", "rws-rw6-fixtures");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Could not locate referencias/rws-rw6-fixtures directory");
}

function parseDigestAuthorizationHeader(header: string): Record<string, string> | null {
  if (!/^Digest\s+/i.test(header.trim())) return null;
  const rest = header.trim().replace(/^Digest\s+/i, "");
  const out: Record<string, string> = {};
  const re = /([a-zA-Z0-9_-]+)\s*=\s*("(?:\\.|[^"])*"|[^,\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const k = m[1]?.toLowerCase();
    const raw = m[2] ?? "";
    if (k) {
      out[k] = raw.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");
    }
  }
  return out;
}

function parseCookies(cookieHeader: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!cookieHeader) return map;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return map;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class FakeRwsServer {
  readonly fixturesDir: string;
  readonly fixtures = new Map<string, FixtureRecord>();
  readonly username: string;
  readonly password: string;
  readonly realm = "validusers@robapi.abb";
  readonly opaque = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
  maxSessions: number;
  authMode: "digest" | "basic";

  private server?: http.Server;
  private activeNonces = new Set<string>();
  private staleNonces = new Set<string>();
  private sessions = new Set<string>();
  private nextForceStale = false;

  // Mutable state layered on top of real RobotWare 6.16 fixtures
  private execState = "stopped";
  private execCycle = "forever";
  private homeFiles = new Map<string, string>();
  private extraModules = new Map<string, string>(); // moduleName -> type
  private symbolValues = new Map<string, string>();
  private signalValues = new Map<string, { type: string; value: string; hasDevice: boolean }>();
  private extraEvents: ExtraEvent[] = [];

  // Telemetry counters for assertions in tests
  readonly stats = {
    requests: 0,
    challengesIssued: 0,
    sessionsCreated: 0,
    cookieHits: 0,
    staleChallenges: 0,
  };

  constructor(options: FakeRwsServerOptions = {}) {
    this.fixturesDir = options.fixturesDir ?? findDefaultFixturesDir();
    this.username = options.username ?? "Default User";
    this.password = options.password ?? "robotics";
    this.maxSessions = options.maxSessions ?? 70;
    this.authMode = options.authMode ?? "digest";

    for (const file of DEFAULT_FIXTURE_FILES) {
      const full = path.join(this.fixturesDir, file);
      const parsed = JSON.parse(fs.readFileSync(full, "utf8")) as FixtureRecord;
      this.fixtures.set(file, parsed);
    }

    // Seed mutable symbols and signals from fixtures
    this.symbolValues.set(
      "T_ROB1/BASE/tool0",
      "[TRUE,[[0,0,0],[1,0,0,0]],[0.001,[0,0,0.001],[1,0,0,0],0,0,0]]",
    );
    this.symbolValues.set("T_ROB1/EGM_Controller/s_mcp_status", '"READY_WAITING_COMMAND"');
    this.symbolValues.set("T_ROB1/EGM_Controller/n_mcp_command", "0");

    this.signalValues.set("DRV1TESTE2", { type: "DO", value: "0", hasDevice: true });
    this.signalValues.set("DRV1BRAKE", { type: "DO", value: "0", hasDevice: true });
    this.signalValues.set("DRV1CHAIN2", { type: "DO", value: "0", hasDevice: true });
    this.signalValues.set("DRV1CHAIN1", { type: "DO", value: "0", hasDevice: true });
    this.signalValues.set("DRV1BRAKEOK", { type: "DI", value: "0", hasDevice: false });
    this.signalValues.set("CAMINO1", { type: "DI", value: "0", hasDevice: false });
    this.signalValues.set("CAMINO2", { type: "DI", value: "0", hasDevice: false });
    this.signalValues.set("INTERRUPCION", { type: "DI", value: "0", hasDevice: false });
  }

  get baseUrl(): string {
    if (!this.server) {
      throw new Error("FakeRwsServer has not been started");
    }
    const addr = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  forceNextStaleNonce(): void {
    this.nextForceStale = true;
  }

  resetState(): void {
    this.activeNonces.clear();
    this.staleNonces.clear();
    this.sessions.clear();
    this.nextForceStale = false;
    this.execState = "stopped";
    this.execCycle = "forever";
    this.homeFiles.clear();
    this.extraModules.clear();
    this.extraEvents = [];
    this.stats.requests = 0;
    this.stats.challengesIssued = 0;
    this.stats.sessionsCreated = 0;
    this.stats.cookieHits = 0;
    this.stats.staleChallenges = 0;
  }

  async start(port = 0): Promise<string> {
    if (this.server) return this.baseUrl;
    this.server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private issueChallenge(res: http.ServerResponse, stale = false): void {
    this.stats.challengesIssued += 1;
    if (stale) this.stats.staleChallenges += 1;

    if (this.authMode === "basic") {
      res.writeHead(401, {
        "Content-Type": "text/plain",
        "WWW-Authenticate": `Basic realm="${this.realm}"`,
      });
      res.end("Access Denied. Login required");
      return;
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    this.activeNonces.add(nonce);
    const challengeFixture = this.fixtures.get("00-challenge-sin-credenciales.json")!;
    res.writeHead(401, {
      "Content-Type": "text/plain",
      "WWW-Authenticate": `Digest realm="${this.realm}", domain="/", qop="auth", nonce="${nonce}", opaque="${this.opaque}", algorithm="MD5", stale="${stale ? "TRUE" : "FALSE"}"`,
    });
    res.end(challengeFixture.body);
  }

  private verifyDigest(method: string, reqUrl: string, params: Record<string, string>): "ok" | "stale" | "fail" {
    const nonce = params.nonce ?? "";
    if (this.staleNonces.has(nonce)) {
      this.staleNonces.delete(nonce);
      return "stale";
    }
    if (!this.activeNonces.has(nonce)) {
      return "fail";
    }
    if (params.username !== this.username || params.realm !== this.realm) {
      return "fail";
    }
    if (params.uri !== reqUrl) {
      return "fail";
    }
    if (this.nextForceStale) {
      this.nextForceStale = false;
      this.activeNonces.delete(nonce);
      return "stale";
    }

    const ha1 = md5(`${this.username}:${this.realm}:${this.password}`);
    const ha2 = md5(`${method.toUpperCase()}:${reqUrl}`);
    const nc = params.nc ?? "";
    const cnonce = params.cnonce ?? "";
    const qop = params.qop ?? "";
    const expected = qop
      ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : md5(`${ha1}:${nonce}:${ha2}`);

    if (params.response !== expected) {
      return "fail";
    }
    return "ok";
  }

  private sendFixture(
    res: http.ServerResponse,
    fixtureFile: string,
    extraHeaders: Record<string, string> = {},
    transformBody?: (body: string) => string,
  ): void {
    const fixture = this.fixtures.get(fixtureFile);
    if (!fixture) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Missing fixture: ${fixtureFile}`);
      return;
    }
    const body = transformBody ? transformBody(fixture.body) : fixture.body;
    res.writeHead(fixture.status, {
      "Content-Type": fixture.headers["content-type"] ?? "application/xhtml+xml",
      ...extraHeaders,
    });
    res.end(body);
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.stats.requests += 1;
    const rawUrl = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();
    const parsedUrl = new URL(rawUrl, "http://127.0.0.1");
    const pathname = parsedUrl.pathname;

    // 1. Session cookie or Digest authentication
    const cookies = parseCookies(req.headers.cookie);
    const sessionCookie = cookies.get("ABBCX");
    const responseHeaders: Record<string, string> = {};

    if (sessionCookie && this.sessions.has(sessionCookie)) {
      this.stats.cookieHits += 1;
    } else {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        this.issueChallenge(res, false);
        return;
      }
      if (this.authMode === "basic") {
        // Basic mode only used to verify clients reject Basic challenges.
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Basic authentication should never be sent");
        return;
      }
      const digestParams = parseDigestAuthorizationHeader(authHeader);
      if (!digestParams) {
        this.issueChallenge(res, false);
        return;
      }
      const check = this.verifyDigest(method, rawUrl, digestParams);
      if (check === "stale") {
        this.issueChallenge(res, true);
        return;
      }
      if (check !== "ok") {
        this.issueChallenge(res, false);
        return;
      }

      if (this.sessions.size >= this.maxSessions) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end(`Too many sessions ${this.sessions.size}/${this.maxSessions}`);
        return;
      }

      const newSession = crypto.randomBytes(12).toString("hex");
      this.sessions.add(newSession);
      this.stats.sessionsCreated += 1;
      responseHeaders["Set-Cookie"] = `ABBCX=${newSession}; path=/; domain=127.0.0.1; httponly`;
    }

    const rawBody = method === "GET" || method === "HEAD" ? "" : await readRequestBody(req);

    // 2. GET endpoints (backed by real RW 6.16 captures)
    if (method === "GET") {
      if (pathname === "/rw/system") {
        this.sendFixture(res, "01-system.json", responseHeaders);
        return;
      }
      if (pathname === "/rw/panel/ctrlstate") {
        this.sendFixture(res, "02-panel-ctrlstate.json", responseHeaders);
        return;
      }
      if (pathname === "/rw/panel/opmode") {
        this.sendFixture(res, "03-panel-opmode.json", responseHeaders);
        return;
      }
      if (pathname === "/rw/rapid/execution") {
        this.sendFixture(res, "04-rapid-execution.json", responseHeaders, (body) =>
          body
            .replace(/class="ctrlexecstate">[^<]*</, `class="ctrlexecstate">${this.execState}<`)
            .replace(/class="cycle">[^<]*</, `class="cycle">${this.execCycle}<`),
        );
        return;
      }
      if (pathname === "/rw/rapid/tasks") {
        this.sendFixture(res, "05-rapid-tasks.json", responseHeaders);
        return;
      }
      if (pathname === "/rw/rapid/modules") {
        const task = parsedUrl.searchParams.get("task") ?? "T_ROB1";
        this.sendFixture(res, "06-rapid-modules-rw6.json", responseHeaders, (body) => {
          if (this.extraModules.size === 0) return body;
          const extraLis = Array.from(this.extraModules.entries())
            .map(
              ([modName, modType]) =>
                `<li class="rap-module-info-li" title="${escapeXml(task)}/${escapeXml(modName)}"><span class="name">${escapeXml(modName)}</span><span class="type">${escapeXml(modType)}</span></li>`,
            )
            .join("");
          return body.replace("</ul>", `${extraLis}</ul>`);
        });
        return;
      }
      // RW7 route that returns 404 on RW6
      if (/^\/rw\/rapid\/tasks\/[^/]+\/modules$/.test(pathname)) {
        this.sendFixture(res, "07-rapid-modules-ruta-rw7-404.json", responseHeaders);
        return;
      }
      // RAPID symbol read
      if (pathname.startsWith("/rw/rapid/symbol/data/RAPID/")) {
        const key = decodeURIComponent(pathname.slice("/rw/rapid/symbol/data/RAPID/".length));
        if (key === "T_ROB1/BASE/tool0" && !this.symbolValues.has("T_ROB1/BASE/tool0:override")) {
          this.sendFixture(res, "08-symbol-tool0.json", responseHeaders);
          return;
        }
        const stored = this.symbolValues.get(key);
        if (stored !== undefined) {
          this.sendFixture(res, "08-symbol-tool0.json", responseHeaders, (body) =>
            body
              .replace(/title="RAPID\/[^"]+"/, `title="RAPID/${escapeXml(key)}"`)
              .replace(/class="value">[^<]*</, `class="value">${escapeXml(stored)}<`),
          );
          return;
        }
        this.sendFixture(res, "09-symbol-no-existe.json", responseHeaders);
        return;
      }
      // Signals list
      if (pathname === "/rw/iosystem/signals") {
        const start = Number(parsedUrl.searchParams.get("start") ?? "0");
        if (start === 0) {
          this.sendFixture(res, "10-signals-pagina.json", responseHeaders, (body) => {
            let updated = body;
            for (const [sigName, sigInfo] of this.signalValues.entries()) {
              const re = new RegExp(
                `(<span class="name">${sigName}<\\/span><span class="type">[^<]*<\\/span><span class="category">[^<]*<\\/span><span class="lvalue">)[^<]*(<\\/span>)`,
              );
              updated = updated.replace(re, `$1${escapeXml(sigInfo.value)}$2`);
            }
            // Strip rel="next" when we only have the 5 fixture signals so pagination terminates cleanly
            return updated.replace(/<a\s+href="signals\?start=5&amp;limit=5"\s+rel="next"><\/a>/, "");
          });
          return;
        }
        res.writeHead(200, { "Content-Type": "application/xhtml+xml", ...responseHeaders });
        res.end('<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><div class="state"><ul></ul></div></body></html>');
        return;
      }
      // Single signal read
      if (pathname.startsWith("/rw/iosystem/signals/")) {
        const sigName = decodeURIComponent(pathname.slice("/rw/iosystem/signals/".length));
        if (sigName === "DRV1TESTE2") {
          const val = this.signalValues.get("DRV1TESTE2")?.value ?? "0";
          this.sendFixture(res, "11-signal-por-nombre.json", responseHeaders, (body) =>
            body.replace(/<span class="lvalue">[^<]*</, `<span class="lvalue">${escapeXml(val)}<`),
          );
          return;
        }
        const sig = this.signalValues.get(sigName);
        if (sig) {
          this.sendFixture(res, "11-signal-por-nombre.json", responseHeaders, (body) =>
            body
              .replace(/DRV1TESTE2/g, escapeXml(sigName))
              .replace(/<span class="type">[^<]*</, `<span class="type">${escapeXml(sig.type)}<`)
              .replace(/<span class="lvalue">[^<]*</, `<span class="lvalue">${escapeXml(sig.value)}<`),
          );
          return;
        }
        this.sendFixture(res, "09-symbol-no-existe.json", responseHeaders, (body) =>
          body.replace(/Symbol not found/, `Signal ${escapeXml(sigName)} not found`),
        );
        return;
      }
      // Event log
      if (/^\/rw\/elog\/\d+$/.test(pathname)) {
        this.sendFixture(res, "12-elog-dominio0.json", responseHeaders, (body) => {
          if (this.extraEvents.length === 0) return body;
          const lis = this.extraEvents
            .map(
              (ev, idx) =>
                `<li class="elog-message-li" title="/rw/elog/0/${900 + idx}"><span class="msgtype">${escapeXml(ev.msgtype)}</span><span class="code">${escapeXml(ev.code)}</span><span class="src-name">${escapeXml(ev.src)}</span><span class="tstamp">${escapeXml(ev.tstamp)}</span><span class="title">${escapeXml(ev.title)}</span><span class="desc">${escapeXml(ev.desc)}</span><span class="conseqs"></span><span class="causes"></span><span class="actions"></span><span class="argc">0</span></li>`,
            )
            .join("");
          return body.replace("<ul>", `<ul>${lis}`);
        });
        return;
      }
      if (pathname === "/rw/motionsystem/mechunits/ROB_1/jointtarget") {
        this.sendFixture(res, "13-jointtarget.json", responseHeaders);
        return;
      }
      if (pathname === "/rw/motionsystem/mechunits/ROB_1/robtarget") {
        this.sendFixture(res, "14-robtarget-tool0-wobj0.json", responseHeaders);
        return;
      }
      if (pathname === "/rw/mastership") {
        this.sendFixture(res, "15-mastership.json", responseHeaders);
        return;
      }
    }

    // 3. Write / file endpoints
    if (method === "PUT" && pathname.startsWith("/fileservice/$HOME/")) {
      const fileName = decodeURIComponent(pathname.slice("/fileservice/$HOME/".length));
      this.homeFiles.set(fileName, rawBody);
      res.writeHead(201, { ...responseHeaders });
      res.end();
      return;
    }

    if (method === "POST") {
      const action = parsedUrl.searchParams.get("action") ?? "";
      const form = new URLSearchParams(rawBody);

      if (pathname.startsWith("/rw/mastership/") && (action === "request" || action === "release")) {
        res.writeHead(204, { ...responseHeaders });
        res.end();
        return;
      }

      if (pathname.startsWith("/rw/rapid/symbol/data/RAPID/") && action === "set") {
        const key = decodeURIComponent(pathname.slice("/rw/rapid/symbol/data/RAPID/".length));
        const val = form.get("value");
        if (val === null) {
          res.writeHead(400, { "Content-Type": "application/xhtml+xml", ...responseHeaders });
          res.end('<div class="status"><span class="code">-1073414146</span><span class="msg">Missing value parameter</span></div>');
          return;
        }
        this.symbolValues.set(key, val);
        if (key === "T_ROB1/BASE/tool0") {
          this.symbolValues.set("T_ROB1/BASE/tool0:override", "1");
        }
        res.writeHead(204, { ...responseHeaders });
        res.end();
        return;
      }

      if (pathname.startsWith("/rw/iosystem/signals/") && action === "set") {
        const sigName = decodeURIComponent(pathname.slice("/rw/iosystem/signals/".length));
        const sig = this.signalValues.get(sigName);
        if (!sig || (sig.type === "DI" && !sig.hasDevice)) {
          res.writeHead(400, { "Content-Type": "application/xhtml+xml", ...responseHeaders });
          res.end(
            '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><div class="status"><span class="code">-1073445881</span><span class="msg">C:\\BUILDAGENTS\\SEABB-IS-13906.1\\_work\\76\\s\\RW\\Areas\\RobApi2\\Components\\rws_iosystem\\rws_resource_iosystem.cpp[3554] Rejected code:-1073445881 icode:-2</span></div></body></html>',
          );
          return;
        }
        sig.value = form.get("lvalue") ?? sig.value;
        res.writeHead(204, { ...responseHeaders });
        res.end();
        return;
      }

      if (/^\/rw\/rapid\/tasks\/[^/]+$/.test(pathname) && action === "loadmod") {
        const modulepath = form.get("modulepath") ?? "";
        const fileName = modulepath.replace(/^\$HOME\//, "");
        const content = this.homeFiles.get(fileName) ?? "";

        // RW6 returns 204 even when the RAPID module has syntax errors!
        const hasSyntaxError =
          content.includes("SYNTAX_ERROR") ||
          !/^\s*MODULE\s+[A-Za-z0-9_]+/im.test(content) ||
          !/^\s*ENDMODULE\b/im.test(content);

        if (hasSyntaxError) {
          const sec = String(this.extraEvents.length % 60).padStart(2, "0");
          this.extraEvents.unshift({
            code: "40520",
            msgtype: "3",
            src: "RAPID",
            tstamp: `2026-11-14 T 23:00:${sec}`,
            title: "Load error",
            desc: `File ${fileName} has RAPID syntax error(s) and was not loaded.`,
          });
        } else {
          const modMatch = /^\s*MODULE\s+([A-Za-z0-9_]+)/im.exec(content);
          const modName = modMatch?.[1] ?? fileName.replace(/\.[^.]+$/, "");
          this.extraModules.set(modName, "ProgMod");
        }
        res.writeHead(204, { ...responseHeaders });
        res.end();
        return;
      }

      if (pathname === "/rw/rapid/execution") {
        if (action === "resetpp") {
          res.writeHead(204, { ...responseHeaders });
          res.end();
          return;
        }
        if (action === "start") {
          this.execState = "running";
          this.execCycle = form.get("cycle") ?? "forever";
          res.writeHead(204, { ...responseHeaders });
          res.end();
          return;
        }
        if (action === "stop") {
          this.execState = "stopped";
          res.writeHead(204, { ...responseHeaders });
          res.end();
          return;
        }
      }
    }

    this.sendFixture(res, "07-rapid-modules-ruta-rw7-404.json", responseHeaders);
  }
}
