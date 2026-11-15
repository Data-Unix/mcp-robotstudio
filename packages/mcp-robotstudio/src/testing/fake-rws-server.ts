import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
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
  /** "digest" (RW6) or "basic" (a host that only offers Basic over HTTP: clients must refuse it) */
  authMode?: "digest" | "basic";
  /** "rws1" (default, HTTP + Digest) or "rws2" (HTTPS + Basic, OmniCore routes) */
  dialect?: "rws1" | "rws2";
  /** Refuse every WebSocket upgrade (simulates a proxy) */
  blockWebSocket?: boolean;
}

export interface FakePcp {
  module: string;
  routine: string;
  line: number;
  column: number;
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

const XHTML = (inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><div class="state">${inner}</div></body></html>`;
const STATUS = (code: string, msg: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><div class="status"><span class="code">${code}</span><span class="msg">${msg}</span></div></body></html>`;

function findUp(rel: string): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(current, rel);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Could not locate ${rel}`);
}

export function findDefaultFixturesDir(): string {
  return findUp(path.join("referencias", "rws-rw6-fixtures"));
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
    if (k) out[k] = raw.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");
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
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function wsFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x81, len]) : len < 65536 ? Buffer.from([0x81, 126, len >> 8, len & 0xff]) : (() => {
    const h = Buffer.alloc(10);
    h[0] = 0x81;
    h[1] = 127;
    h.writeBigUInt64BE(BigInt(len), 2);
    return h;
  })();
  return Buffer.concat([header, payload]);
}

const HIGH_PRIORITY_RE = /^\/rw\/iosystem\/signals\/.+;state$|^\/rw\/rapid\/symbol\/data\/RAPID\/.+;value$/;

export class FakeRwsServer {
  readonly fixturesDir: string;
  readonly fixtures = new Map<string, FixtureRecord>();
  readonly username: string;
  readonly password: string;
  readonly realm = "validusers@robapi.abb";
  readonly opaque = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
  readonly dialect: "rws1" | "rws2";
  maxSessions: number;
  authMode: "digest" | "basic";
  blockWebSocket: boolean;

  private server?: http.Server | https.Server;
  private activeNonces = new Set<string>();
  private staleNonces = new Set<string>();
  private sessions = new Set<string>();
  private nextForceStale = false;

  // Mutable state layered on top of real RobotWare 6.16 fixtures
  private execState = "stopped";
  private execCycle = "forever";
  private homeFiles = new Map<string, string>();
  private tempFiles = new Map<string, string>();
  private extraModules = new Map<string, string>(); // moduleName -> type
  private moduleSources = new Map<string, string>();
  private symbolValues = new Map<string, string>();
  private symbolTypes = new Map<string, { symtyp: string; dattyp: string }>();
  private signalValues = new Map<string, { type: string; value: string; hasDevice: boolean }>();
  private extraEvents: ExtraEvent[] = [];
  private subscriptions = new Map<string, { uris: string[]; sockets: Set<Duplex> }>();
  private nextSubscription = 1;
  speedRatio = 100;
  pcp: FakePcp | null = null;
  opmode = "MANR";

  // Telemetry counters for assertions in tests
  readonly stats = {
    requests: 0,
    challengesIssued: 0,
    sessionsCreated: 0,
    cookieHits: 0,
    staleChallenges: 0,
    basicLogins: 0,
    wsUpgrades: 0,
    wsRejected: 0,
    backups: 0,
  };
  readonly requestLog: string[] = [];

  constructor(options: FakeRwsServerOptions = {}) {
    this.fixturesDir = options.fixturesDir ?? findDefaultFixturesDir();
    this.username = options.username ?? "Default User";
    this.password = options.password ?? "robotics";
    this.maxSessions = options.maxSessions ?? 70;
    this.authMode = options.authMode ?? "digest";
    this.dialect = options.dialect ?? "rws1";
    this.blockWebSocket = options.blockWebSocket ?? false;

    for (const file of DEFAULT_FIXTURE_FILES) {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.fixturesDir, file), "utf8")) as FixtureRecord;
      this.fixtures.set(file, parsed);
    }
    this.seed();
  }

  private seed(): void {
    this.symbolValues.clear();
    this.symbolTypes.clear();
    this.symbolValues.set("T_ROB1/BASE/tool0", "[TRUE,[[0,0,0],[1,0,0,0]],[0.001,[0,0,0.001],[1,0,0,0],0,0,0]]");
    this.symbolValues.set("T_ROB1/EGM_Controller/s_mcp_status", '"READY_WAITING_COMMAND"');
    this.symbolValues.set("T_ROB1/EGM_Controller/n_mcp_command", "0");
    this.symbolTypes.set("T_ROB1/BASE/tool0", { symtyp: "per", dattyp: "tooldata" });
    this.symbolTypes.set("T_ROB1/EGM_Controller/s_mcp_status", { symtyp: "per", dattyp: "string" });
    this.symbolTypes.set("T_ROB1/EGM_Controller/n_mcp_command", { symtyp: "per", dattyp: "num" });
    this.moduleSources.set("BASE", "%%%\n  VERSION:1\n  LANGUAGE:ENGLISH\n%%%\n\nMODULE BASE (SYSMODULE, NOSTEPIN, VIEWONLY)\n  PERS tooldata tool0 := [TRUE,[[0,0,0],[1,0,0,0]],[0.001,[0,0,0.001],[1,0,0,0],0,0,0]];\nENDMODULE\n");
    this.moduleSources.set("user", "MODULE user (SYSMODULE)\nENDMODULE\n");

    this.signalValues.clear();
    for (const [n, t, d] of [
      ["DRV1TESTE2", "DO", true],
      ["DRV1BRAKE", "DO", true],
      ["DRV1CHAIN2", "DO", true],
      ["DRV1CHAIN1", "DO", true],
      ["DRV1BRAKEOK", "DI", false],
      ["CAMINO1", "DI", false],
      ["CAMINO2", "DI", false],
      ["INTERRUPCION", "DI", false],
    ] as Array<[string, string, boolean]>) {
      this.signalValues.set(n, { type: t, value: "0", hasDevice: d });
    }
  }

  /** Defines a RAPID symbol with type information (for PERS / CONST checks). */
  defineSymbol(key: string, value: string, symtyp: "per" | "var" | "con", dattyp: string): void {
    this.symbolValues.set(key, value);
    this.symbolTypes.set(key, { symtyp, dattyp });
  }

  /** Makes a module visible in /rw/rapid/modules with this source (for save/diff tests). */
  defineModule(name: string, source: string): void {
    this.extraModules.set(name, "ProgMod");
    this.moduleSources.set(name, source);
  }

  addEvent(ev: Omit<ExtraEvent, "tstamp"> & { tstamp?: string }): void {
    this.extraEvents.unshift({ tstamp: "2026-11-15 T 12:00:00", ...ev });
  }

  get tempFileNames(): string[] {
    return [...this.tempFiles.keys()];
  }

  get baseUrl(): string {
    if (!this.server) throw new Error("FakeRwsServer has not been started");
    const addr = this.server.address() as AddressInfo;
    return `${this.dialect === "rws2" ? "https" : "http"}://127.0.0.1:${addr.port}`;
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
    this.tempFiles.clear();
    this.extraModules.clear();
    this.extraEvents = [];
    this.speedRatio = 100;
    this.pcp = null;
    this.seed();
    for (const k of Object.keys(this.stats) as Array<keyof typeof this.stats>) this.stats[k] = 0;
    this.requestLog.length = 0;
  }

  async start(port = 0): Promise<string> {
    if (this.server) return this.baseUrl;
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => void this.handleHttpRequest(req, res);
    if (this.dialect === "rws2") {
      const dir = findUp(path.join("referencias", "rws-test-tls"));
      this.server = https.createServer(
        { key: fs.readFileSync(path.join(dir, "test-key.pem")), cert: fs.readFileSync(path.join(dir, "test-cert.pem")) },
        handler,
      );
    } else {
      this.server = http.createServer(handler);
    }
    this.server.on("upgrade", (req, socket) => this.handleUpgrade(req, socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", () => resolve());
    });
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const s of this.subscriptions.values()) for (const sock of s.sockets) sock.destroy();
    this.subscriptions.clear();
    const srv = this.server;
    this.server = undefined;
    srv.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve())));
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------
  private issueChallenge(res: http.ServerResponse, stale = false): void {
    this.stats.challengesIssued += 1;
    if (stale) this.stats.staleChallenges += 1;

    if (this.authMode === "basic" || this.dialect === "rws2") {
      res.writeHead(401, { "Content-Type": "text/plain", "WWW-Authenticate": `Basic realm="${this.realm}"` });
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
    if (!this.activeNonces.has(nonce)) return "fail";
    if (params.username !== this.username || params.realm !== this.realm) return "fail";
    if (params.uri !== reqUrl) return "fail";
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
    const expected = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
    return params.response === expected ? "ok" : "fail";
  }

  /** Returns response headers for an authenticated request, or null after answering 401/403/503. */
  private authenticate(req: http.IncomingMessage, res: http.ServerResponse, method: string, rawUrl: string): Record<string, string | string[]> | null {
    const cookies = parseCookies(req.headers.cookie);
    const sessionCookie = cookies.get("ABBCX");
    if (sessionCookie && this.sessions.has(sessionCookie)) {
      this.stats.cookieHits += 1;
      return {};
    }
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      this.issueChallenge(res, false);
      return null;
    }
    if (this.dialect === "rws2") {
      const expected = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
      if (authHeader !== expected) {
        this.issueChallenge(res, false);
        return null;
      }
      this.stats.basicLogins += 1;
    } else if (this.authMode === "basic") {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Basic authentication should never be sent");
      return null;
    } else {
      const digestParams = parseDigestAuthorizationHeader(authHeader);
      if (!digestParams) {
        this.issueChallenge(res, false);
        return null;
      }
      const check = this.verifyDigest(method, rawUrl, digestParams);
      if (check !== "ok") {
        this.issueChallenge(res, check === "stale");
        return null;
      }
    }
    if (this.sessions.size >= this.maxSessions) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end(`Too many sessions ${this.sessions.size}/${this.maxSessions}`);
      return null;
    }
    const newSession = crypto.randomBytes(12).toString("hex");
    this.sessions.add(newSession);
    this.stats.sessionsCreated += 1;
    return {
      "Set-Cookie": [
        `-http-session-=${crypto.randomBytes(8).toString("hex")}; path=/; domain=127.0.0.1; httponly`,
        `ABBCX=${newSession}; path=/; domain=127.0.0.1; httponly`,
      ],
    };
  }

  private sendFixture(
    res: http.ServerResponse,
    fixtureFile: string,
    extraHeaders: Record<string, string | string[]> = {},
    transformBody?: (body: string) => string,
  ): void {
    const fixture = this.fixtures.get(fixtureFile);
    if (!fixture) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Missing fixture: ${fixtureFile}`);
      return;
    }
    const body = transformBody ? transformBody(fixture.body) : fixture.body;
    res.writeHead(fixture.status, { "Content-Type": fixture.headers["content-type"] ?? "application/xhtml+xml", ...extraHeaders });
    res.end(body);
  }

  private send(res: http.ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}): void {
    res.writeHead(status, { "Content-Type": "application/xhtml+xml", ...headers });
    res.end(body);
  }

  /**
   * Maps RWS 2.0 routes to the internal RWS 1.0 form. Returns null when the
   * route belongs to the other dialect (so the server answers 404 and a client
   * using the wrong dialect fails loudly).
   */
  private normalize(method: string, pathname: string, search: URLSearchParams): { pathname: string; search: URLSearchParams } | null {
    const s = new URLSearchParams(search);
    if (this.dialect === "rws1") {
      if (/^\/fileservice\/(HOME|TEMP)(\/|$)/.test(pathname)) return null;
      if (/^\/rw\/rapid\/execution\/(start|stop|resetpp)$/.test(pathname)) return null;
      if (/^\/rw\/mastership\/edit\//.test(pathname)) return null;
      return { pathname, search: s };
    }
    if (s.has("action")) return null; // RWS 2.0 has no ?action=
    if (/^\/fileservice\/\$/.test(pathname)) return null; // RWS 2.0 uses HOME / TEMP
    let p = pathname;
    let m: RegExpExecArray | null;
    if ((m = /^\/rw\/rapid\/symbol\/RAPID\/(.+)\/(data|properties)$/.exec(p))) {
      p = `/rw/rapid/symbol/${m[2]}/RAPID/${m[1]}`;
      if (m[2] === "data" && method === "POST") s.set("action", "set");
    } else if ((m = /^\/rw\/rapid\/tasks\/([^/]+)\/modules$/.exec(p)) && method === "GET") {
      p = "/rw/rapid/modules";
      s.set("task", m[1]!);
    } else if ((m = /^\/rw\/rapid\/tasks\/([^/]+)\/modules\/([^/]+)\/save$/.exec(p))) {
      p = `/rw/rapid/modules/${m[2]}`;
      s.set("task", m[1]!);
      s.set("action", "save");
    } else if ((m = /^\/rw\/rapid\/tasks\/([^/]+)\/loadmod$/.exec(p))) {
      p = `/rw/rapid/tasks/${m[1]}`;
      s.set("action", "loadmod");
    } else if ((m = /^\/rw\/rapid\/execution\/(start|stop|resetpp)$/.exec(p))) {
      p = "/rw/rapid/execution";
      s.set("action", m[1]!);
    } else if ((m = /^\/rw\/mastership\/edit\/(request|release)$/.exec(p))) {
      p = "/rw/mastership/rapid";
      s.set("action", m[1]!);
    } else if (/^\/rw\/mastership\/(rapid|cfg)/.test(p)) {
      return null;
    } else if ((m = /^\/rw\/iosystem\/signals\/(.+)\/set-value$/.exec(p))) {
      p = `/rw/iosystem/signals/${m[1]}`;
      s.set("action", "set");
    } else if (p === "/rw/panel/speedratio" && method === "POST") {
      s.set("action", "setspeedratio");
    } else if (p === "/ctrl/backup/create") {
      p = "/ctrl/backup";
      s.set("action", "backup");
    } else if ((m = /^\/fileservice\/(HOME|TEMP)(\/.*)?$/.exec(p))) {
      p = `/fileservice/$${m[1]}${m[2] ?? ""}`;
    }
    return { pathname: p, search: s };
  }

  private moduleSourceFor(name: string): string | undefined {
    return this.moduleSources.get(name);
  }

  private pcpXml(): string {
    // Span names as captured live on RW 6.16 (referencias/rws-rw6-fixtures/16-pcp-en-ejecucion.json).
    const li = (title: string) =>
      this.pcp
        ? title === "progpointer"
          ? `<li class="pcp-info" title="${title}"><span class="beginposition">${this.pcp.line},${this.pcp.column}</span><span class="endposition">${this.pcp.line},${this.pcp.column + 10}</span><span class="modulemame">${escapeXml(this.pcp.module)}</span><span class="routinename">${escapeXml(this.pcp.routine)}</span><span class="changecount">-1</span><span class="executiontype">normal</span></li>`
          : `<li class="pcp-info" title="${title}"><span class="begposition">${this.pcp.line},${this.pcp.column}</span><span class="endposition">${this.pcp.line},${this.pcp.column + 10}</span><span class="modulename">${escapeXml(this.pcp.module)}</span><span class="routinename">${escapeXml(this.pcp.routine)}</span><span class="changecount">-1</span></li>`
        : `<li class="pcp-info" title="${title}"> <a href="${this.baseUrl}/rw/retcode?code=-1073442809" rel="error" class="pcp-info"/></li>`;
    return XHTML(`<a href="tasks/T_ROB1/pcp" rel="self"></a><ul>${li("progpointer")}${li("motionpointer")}</ul>`);
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------
  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.stats.requests += 1;
    const rawUrl = req.url ?? "/";
    const method = (req.method ?? "GET").toUpperCase();
    const parsedUrl = new URL(rawUrl, "http://127.0.0.1");
    this.requestLog.push(`${method} ${rawUrl}`);

    const responseHeaders = this.authenticate(req, res, method, rawUrl);
    if (!responseHeaders) return;

    if (this.dialect === "rws2" && !/v=2\.0/.test(String(req.headers.accept ?? ""))) {
      this.send(res, 406, STATUS("-1073414145", "RWS 2.0 requires Accept: application/xhtml+xml;v=2.0 or application/hal+json;v=2.0"), responseHeaders);
      return;
    }

    const norm = this.normalize(method, parsedUrl.pathname, parsedUrl.searchParams);
    if (!norm) {
      this.send(res, 404, STATUS("-1073414146", `Route not valid for ${this.dialect}: ${method} ${parsedUrl.pathname}`), responseHeaders);
      return;
    }
    const pathname = norm.pathname;
    const search = norm.search;
    const rawBody = method === "GET" || method === "HEAD" || method === "DELETE" ? "" : await readRequestBody(req);
    if (method === "POST" && rawBody && !/application\/x-www-form-urlencoded/.test(String(req.headers["content-type"] ?? ""))) {
      this.send(res, 415, STATUS("-1073435898", "Only supports Content-Type: application/x-www-form-urlencoded"), responseHeaders);
      return;
    }
    const form = new URLSearchParams(rawBody);
    const action = search.get("action") ?? "";

    if (method === "GET") {
      if (pathname === "/rw/system") return this.sendFixture(res, "01-system.json", responseHeaders);
      if (pathname === "/rw/panel/ctrlstate") return this.sendFixture(res, "02-panel-ctrlstate.json", responseHeaders);
      if (pathname === "/rw/panel/opmode")
        return this.sendFixture(res, "03-panel-opmode.json", responseHeaders, (b) => b.replace(/class="opmode">[^<]*</, `class="opmode">${this.opmode}<`));
      if (pathname === "/rw/rapid/execution") {
        return this.sendFixture(res, "04-rapid-execution.json", responseHeaders, (body) =>
          body
            .replace(/class="ctrlexecstate">[^<]*</, `class="ctrlexecstate">${this.execState}<`)
            .replace(/class="cycle">[^<]*</, `class="cycle">${this.execCycle}<`),
        );
      }
      if (pathname === "/rw/rapid/tasks") return this.sendFixture(res, "05-rapid-tasks.json", responseHeaders);
      if (/^\/rw\/rapid\/tasks\/[^/]+\/pcp$/.test(pathname)) return this.send(res, 200, this.pcpXml(), responseHeaders);
      if (pathname === "/rw/panel/speedratio") {
        return this.send(res, 200, XHTML(`<ul><li class="pnl-speedratio" title="speedratio"><span class="speedratio">${this.speedRatio}</span></li></ul>`), responseHeaders);
      }
      if (pathname === "/rw/rapid/modules") {
        const task = search.get("task") ?? "T_ROB1";
        return this.sendFixture(res, "06-rapid-modules-rw6.json", responseHeaders, (body) => {
          if (this.extraModules.size === 0) return body;
          const extraLis = Array.from(this.extraModules.entries())
            .map(([modName, modType]) => `<li class="rap-module-info-li" title="${escapeXml(task)}/${escapeXml(modName)}"><span class="name">${escapeXml(modName)}</span><span class="type">${escapeXml(modType)}</span></li>`)
            .join("");
          return body.replace("</ul>", `${extraLis}</ul>`);
        });
      }
      if (/^\/rw\/rapid\/tasks\/[^/]+\/modules$/.test(pathname)) return this.sendFixture(res, "07-rapid-modules-ruta-rw7-404.json", responseHeaders);
      if (pathname.startsWith("/rw/rapid/symbol/properties/RAPID/")) {
        const key = decodeURIComponent(pathname.slice("/rw/rapid/symbol/properties/RAPID/".length));
        const t = this.symbolTypes.get(key);
        if (!t) return this.sendFixture(res, "09-symbol-no-existe.json", responseHeaders);
        const cls = t.symtyp === "per" ? "rap-symproppers" : t.symtyp === "con" ? "rap-sympropconstant" : "rap-sympropvar";
        return this.send(res, 200, XHTML(`<ul><li class="${cls}" title="RAPID/${escapeXml(key)}"><span class="symburl">RAPID/${escapeXml(key)}</span><span class="symtyp">${t.symtyp}</span><span class="dattyp">${t.dattyp}</span><span class="rdonly">false</span></li></ul>`), responseHeaders);
      }
      if (pathname.startsWith("/rw/rapid/symbol/data/RAPID/")) {
        const key = decodeURIComponent(pathname.slice("/rw/rapid/symbol/data/RAPID/".length));
        if (key === "T_ROB1/BASE/tool0" && !this.symbolValues.has("T_ROB1/BASE/tool0:override")) {
          return this.sendFixture(res, "08-symbol-tool0.json", responseHeaders);
        }
        const stored = this.symbolValues.get(key);
        if (stored !== undefined) {
          return this.sendFixture(res, "08-symbol-tool0.json", responseHeaders, (body) =>
            body.replace(/title="RAPID\/[^"]+"/, `title="RAPID/${escapeXml(key)}"`).replace(/class="value">[^<]*</, `class="value">${escapeXml(stored)}<`),
          );
        }
        return this.sendFixture(res, "09-symbol-no-existe.json", responseHeaders);
      }
      if (pathname === "/rw/iosystem/signals") {
        const start = Number(search.get("start") ?? "0");
        if (start === 0) {
          return this.sendFixture(res, "10-signals-pagina.json", responseHeaders, (body) => {
            let updated = body;
            for (const [sigName, sigInfo] of this.signalValues.entries()) {
              const re = new RegExp(`(<span class="name">${sigName}<\\/span><span class="type">[^<]*<\\/span><span class="category">[^<]*<\\/span><span class="lvalue">)[^<]*(<\\/span>)`);
              updated = updated.replace(re, `$1${escapeXml(sigInfo.value)}$2`);
            }
            return updated.replace(/<a\s+href="signals\?start=5&amp;limit=5"\s+rel="next"><\/a>/, "");
          });
        }
        return this.send(res, 200, XHTML("<ul></ul>"), responseHeaders);
      }
      if (pathname.startsWith("/rw/iosystem/signals/")) {
        const sigName = decodeURIComponent(pathname.slice("/rw/iosystem/signals/".length));
        const sig = this.signalValues.get(sigName);
        if (sig) {
          return this.sendFixture(res, "11-signal-por-nombre.json", responseHeaders, (body) =>
            body
              .replace(/DRV1TESTE2/g, escapeXml(sigName))
              .replace(/<span class="type">[^<]*</, `<span class="type">${escapeXml(sig.type)}<`)
              .replace(/<span class="lvalue">[^<]*</, `<span class="lvalue">${escapeXml(sig.value)}<`),
          );
        }
        return this.sendFixture(res, "09-symbol-no-existe.json", responseHeaders, (body) => body.replace(/Symbol not found/, `Signal ${escapeXml(sigName)} not found`));
      }
      if (/^\/rw\/elog\/\d+$/.test(pathname)) {
        return this.sendFixture(res, "12-elog-dominio0.json", responseHeaders, (body) => {
          if (this.extraEvents.length === 0) return body;
          const lis = this.extraEvents
            .map((ev, idx) => `<li class="elog-message-li" title="/rw/elog/0/${900 + idx}"><span class="msgtype">${escapeXml(ev.msgtype)}</span><span class="code">${escapeXml(ev.code)}</span><span class="src-name">${escapeXml(ev.src)}</span><span class="tstamp">${escapeXml(ev.tstamp)}</span><span class="title">${escapeXml(ev.title)}</span><span class="desc">${escapeXml(ev.desc)}</span><span class="conseqs"></span><span class="causes"></span><span class="actions"></span><span class="argc">0</span></li>`)
            .join("");
          return body.replace("<ul>", `<ul>${lis}`);
        });
      }
      if (pathname === "/rw/motionsystem/mechunits/ROB_1") {
        return this.send(res, 200, XHTML('<ul><li class="ms-mechunit" title="ROB_1"><span class="tool-name">tool0</span><span class="wobj-name">wobj0</span><span class="status">Synchronized</span><span class="mode">Activated</span></li></ul>'), responseHeaders);
      }
      if (pathname === "/rw/motionsystem/mechunits/ROB_1/jointtarget") return this.sendFixture(res, "13-jointtarget.json", responseHeaders);
      if (pathname === "/rw/motionsystem/mechunits/ROB_1/robtarget") return this.sendFixture(res, "14-robtarget-tool0-wobj0.json", responseHeaders);
      if (pathname === "/rw/mastership") return this.sendFixture(res, "15-mastership.json", responseHeaders);
      if (pathname === "/users") {
        return this.send(res, 200, XHTML(`<a href="grants" rel="grants"></a><ul><li class="user-rmmp-li" title="rmmp"><a href="rmmp" rel="self"></a></li><li class="user" title="${escapeXml(this.username)}"><span class="name">${escapeXml(this.username)}</span></li></ul>`), responseHeaders);
      }
      if (pathname === "/users/rmmp") {
        return this.send(res, 200, XHTML('<ul><li class="user-rmmp" title="state"><span class="userid">0</span><span class="privilege">none</span><span class="rmmpheldbyme">false</span></li></ul>'), responseHeaders);
      }
      if (pathname === "/users/grants") {
        return this.send(res, 200, XHTML(`<ul>${["UAS_FULL_ACCESS", "UAS_BACKUP", "UAS_IO_WRITE", "UAS_RAPID_DEBUG"].map((g) => `<li class="user-grant" title="${g}"></li>`).join(" ")}</ul>`), responseHeaders);
      }
      if (pathname === "/ctrl/backup" && search.get("action") === "backupstate") {
        const st = this.stats.backups > 0 ? "Backup Ready" : "Init State";
        return this.send(res, 200, XHTML(`<ul><li class="ctrl-backup-state" title="backup state"><span class="backup state">${st}</span></li></ul>`), responseHeaders);
      }
      if (/^\/progress\/\d+$/.test(pathname)) {
        return this.send(res, 200, XHTML('<ul><li class="progress" title="progress"><span class="state">FINISHED</span><span class="code">0</span></li></ul>'), responseHeaders);
      }
      const fsm = /^\/fileservice\/\$(HOME|TEMP)(?:\/(.+))?$/.exec(pathname);
      if (fsm) {
        const store = fsm[1] === "HOME" ? this.homeFiles : this.tempFiles;
        if (!fsm[2]) {
          const lis = [...store.entries()].map(([n, c]) => `<li class="fs-file" title="${escapeXml(n)}"><span class="fs-size">${c.length}</span><span class="fs-mdate">2026-11-15 T 12:00:00</span></li>`).join("");
          return this.send(res, 200, XHTML(`<ul>${lis}</ul>`), responseHeaders);
        }
        const content = store.get(decodeURIComponent(fsm[2]));
        if (content === undefined) return this.send(res, 404, STATUS("-1073414146", "Resource does not exist"), responseHeaders);
        res.writeHead(200, { "Content-Type": "text/plain", ...responseHeaders });
        res.end(content);
        return;
      }
    }

    if (method === "DELETE") {
      const fsm = /^\/fileservice\/\$(HOME|TEMP)\/(.+)$/.exec(pathname);
      if (fsm) {
        const store = fsm[1] === "HOME" ? this.homeFiles : this.tempFiles;
        const ok = store.delete(decodeURIComponent(fsm[2]!));
        return this.send(res, ok ? 204 : 404, ok ? "" : STATUS("-1073414146", "Resource does not exist"), responseHeaders);
      }
      const sub = /^\/subscription\/(\d+)$/.exec(pathname);
      if (sub) {
        const s = this.subscriptions.get(sub[1]!);
        s?.sockets.forEach((x) => x.end());
        this.subscriptions.delete(sub[1]!);
        return this.send(res, s ? 200 : 404, "", responseHeaders);
      }
    }

    if (method === "PUT" && pathname.startsWith("/fileservice/$HOME/")) {
      this.homeFiles.set(decodeURIComponent(pathname.slice("/fileservice/$HOME/".length)), rawBody);
      res.writeHead(201, { ...responseHeaders });
      res.end();
      return;
    }

    if (method === "POST") {
      if (pathname === "/subscription") return this.createSubscription(res, form, responseHeaders);

      if (pathname.startsWith("/rw/mastership/") && (action === "request" || action === "release")) return this.send(res, 204, "", responseHeaders);

      if (pathname.startsWith("/rw/rapid/symbol/data/RAPID/") && action === "set") {
        const key = decodeURIComponent(pathname.slice("/rw/rapid/symbol/data/RAPID/".length));
        const val = form.get("value");
        if (val === null) return this.send(res, 400, STATUS("-1073414146", "Missing value parameter"), responseHeaders);
        this.symbolValues.set(key, val);
        if (key === "T_ROB1/BASE/tool0") this.symbolValues.set("T_ROB1/BASE/tool0:override", "1");
        this.push(`/rw/rapid/symbol/data/RAPID/${key};value`, "rap-value-ev", { value: val });
        return this.send(res, 204, "", responseHeaders);
      }

      if (pathname.startsWith("/rw/iosystem/signals/") && action === "set") {
        const sigName = decodeURIComponent(pathname.slice("/rw/iosystem/signals/".length));
        const sig = this.signalValues.get(sigName);
        if (!sig || (sig.type === "DI" && !sig.hasDevice)) {
          return this.send(res, 400, STATUS("-1073445881", "rws_resource_iosystem.cpp[3554] Rejected code:-1073445881 icode:-2"), responseHeaders);
        }
        sig.value = form.get("lvalue") ?? sig.value;
        this.push(`/rw/iosystem/signals/${sigName};state`, "ios-signalstate-ev", { name: sigName, lvalue: sig.value });
        return this.send(res, 204, "", responseHeaders);
      }

      if (/^\/rw\/rapid\/tasks\/[^/]+$/.test(pathname) && action === "loadmod") {
        const modulepath = form.get("modulepath") ?? "";
        const fileName = modulepath.replace(/^\$?HOME\//, "");
        const content = this.homeFiles.get(fileName) ?? "";
        const hasSyntaxError = content.includes("SYNTAX_ERROR") || !/^\s*MODULE\s+[A-Za-z0-9_]+/im.test(content) || !/^\s*ENDMODULE\b/im.test(content);
        if (hasSyntaxError) {
          const sec = String(this.extraEvents.length % 60).padStart(2, "0");
          this.extraEvents.unshift({ code: "40520", msgtype: "3", src: "RAPID", tstamp: `2026-11-14 T 23:00:${sec}`, title: "Load error", desc: `File ${fileName} has RAPID syntax error(s) and was not loaded.` });
        } else {
          const modName = /^\s*MODULE\s+([A-Za-z0-9_]+)/im.exec(content)?.[1] ?? fileName.replace(/\.[^.]+$/, "");
          this.extraModules.set(modName, "ProgMod");
          this.moduleSources.set(modName, content);
        }
        return this.send(res, 204, "", responseHeaders); // RW6 answers 204 even on syntax errors
      }

      const save = /^\/rw\/rapid\/modules\/([^/]+)$/.exec(pathname);
      if (save && action === "save") {
        const mod = decodeURIComponent(save[1]!);
        const src = this.moduleSourceFor(mod);
        if (src === undefined) return this.sendFixture(res, "09-symbol-no-existe.json", responseHeaders);
        const dir = form.get("path") ?? "";
        // RW 6.16 (verified live): names of up to 7 chars get ".mod"; longer ones are cut to 7 chars without extension.
        const requested = form.get("name") ?? mod;
        const name = requested.length <= 7 ? `${requested}.mod` : requested.slice(0, 7);
        if (/^\$?TEMP$/.test(dir)) this.tempFiles.set(name, src);
        else if (/^\$?HOME$/.test(dir)) this.homeFiles.set(name, src);
        else return this.send(res, 400, STATUS("-1073414146", `Invalid path ${dir}`), responseHeaders);
        return this.send(res, 204, "", responseHeaders);
      }

      if (pathname === "/rw/panel/speedratio" && action === "setspeedratio") {
        const v = Number(form.get("speed-ratio"));
        if (!Number.isInteger(v) || v < 0 || v > 100) return this.send(res, 400, STATUS("-1073414146", "Invalid speed-ratio"), responseHeaders);
        this.speedRatio = v;
        this.push("/rw/panel/speedratio", "pnl-speedratio-ev", { speedratio: String(v) });
        return this.send(res, 204, "", responseHeaders);
      }

      if (pathname === "/ctrl/backup" && action === "backup") {
        // RW 6.16 (verified live) only accepts a fileservice path: /fileservice/$TEMP/<dir>
        const target = form.get("backup") ?? "";
        if (!/^\/fileservice\/\$?TEMP\/[A-Za-z0-9_-]+$/.test(target)) return this.send(res, 400, STATUS("-1073414146", "Invalid File Service path -1073414146 -1"), responseHeaders);
        this.stats.backups += 1;
        return this.send(res, 202, "", { ...responseHeaders, Location: `${this.baseUrl}/progress/${this.stats.backups}` });
      }

      if (pathname === "/rw/rapid/execution") {
        if (action === "resetpp") {
          this.pcp = { module: [...this.extraModules.keys()][0] ?? "user", routine: "main", line: 1, column: 1 };
          return this.send(res, 204, "", responseHeaders);
        }
        if (action === "start" || action === "stop") {
          this.execState = action === "start" ? "running" : "stopped";
          if (action === "start") this.execCycle = form.get("cycle") ?? "forever";
          this.push("/rw/rapid/execution;ctrlexecstate", "rap-ctrlexecstate-ev", { ctrlexecstate: this.execState });
          return this.send(res, 204, "", responseHeaders);
        }
      }
    }

    this.sendFixture(res, "07-rapid-modules-ruta-rw7-404.json", responseHeaders);
  }

  // -------------------------------------------------------------------------
  // Subscriptions + WebSocket
  // -------------------------------------------------------------------------
  private currentValues(uri: string): { cls: string; spans: Record<string, string> } | null {
    if (uri === "/rw/panel/ctrlstate") return { cls: "pnl-ctrlstate-ev", spans: { ctrlstate: "guardstop" } };
    if (uri === "/rw/panel/speedratio") return { cls: "pnl-speedratio-ev", spans: { speedratio: String(this.speedRatio) } };
    if (uri === "/rw/rapid/execution;ctrlexecstate") return { cls: "rap-ctrlexecstate-ev", spans: { ctrlexecstate: this.execState } };
    if (uri === "/rw/elog/0") return { cls: "elog-message-ev", spans: {} };
    let m = /^\/rw\/iosystem\/signals\/(.+);state$/.exec(uri);
    if (m) {
      const s = this.signalValues.get(m[1]!);
      return s ? { cls: "ios-signalstate-ev", spans: { name: m[1]!, lvalue: s.value } } : null;
    }
    m = /^\/rw\/rapid\/symbol\/data\/RAPID\/(.+);value$/.exec(uri);
    if (m) {
      const v = this.symbolValues.get(m[1]!);
      return v !== undefined ? { cls: "rap-value-ev", spans: { value: v } } : null;
    }
    if (/^\/rw\/rapid\/tasks\/[^/]+\/pcp;programpointerchange$/.test(uri)) {
      // event format captured live on RW 6.16 (fixture 19)
      const p = this.pcp;
      return { cls: "rap-pp-ev", spans: p ? { "module-name": p.module, "routine-name": p.routine, BegPosLine: String(p.line), BegPosCol: String(p.column) } : {} };
    }
    return null;
  }

  private evLi(uri: string, cls: string, spans: Record<string, string>): string {
    // RW 6.16 sends symbol values in a sibling <li class="rap-data"> (captured live).
    if (cls === "rap-value-ev") {
      const key = uri.replace(/^\/rw\/rapid\/symbol\/data\/RAPID\//, "").replace(/;value$/, "");
      return `<li class="rap-value-ev" title="value"><a href="${escapeXml(uri)}" rel="self"/></li><li class="rap-data" title="RAPID/${escapeXml(key)}"><span class="value">${escapeXml(spans.value ?? "")}</span></li>`;
    }
    return `<li class="${cls}" title="${escapeXml(uri)}"><a href="${escapeXml(uri)}" rel="self"></a>${Object.entries(spans).map(([k, v]) => `<span class="${k}">${escapeXml(v)}</span>`).join("")}</li>`;
  }

  private createSubscription(res: http.ServerResponse, form: URLSearchParams, headers: Record<string, string | string[]>): void {
    const ids = form.getAll("resources");
    if (ids.length === 0) return this.send(res, 400, STATUS("-1073414146", "No resources in Create Subscription request"), headers);
    const uris: string[] = [];
    const lis: string[] = [];
    for (const id of ids) {
      const uri = form.get(id) ?? "";
      const prio = form.get(`${id}-p`) ?? "1";
      const cur = this.currentValues(uri);
      if (!cur) return this.send(res, 400, STATUS("-1073414146", "Invalid resource URI in Create Subscription request"), headers);
      if (prio === "2") {
        const sym = /^\/rw\/rapid\/symbol\/data\/RAPID\/(.+);value$/.exec(uri);
        if (sym && this.symbolTypes.get(sym[1]!)?.symtyp !== "per") {
          return this.send(res, 400, STATUS("-1073414146", "Invalid resource URI in Create Subscription request"), headers);
        }
        if (!HIGH_PRIORITY_RE.test(uri)) return this.send(res, 400, STATUS("-1073414146", "Resource can not be subscribed on Highpriority"), headers);
      }
      uris.push(uri);
      lis.push(this.evLi(uri, cur.cls, cur.spans));
    }
    const id = String(this.nextSubscription++);
    this.subscriptions.set(id, { uris, sockets: new Set() });
    const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/poll/${id}`;
    this.send(res, 201, XHTML(`<a href="subscription/${id}" rel="group"></a><a href="${wsUrl}" rel="self"></a><ul>${lis.join(" ")}</ul>`), { ...headers, Location: wsUrl });
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex): void {
    const reject = (status: number, msg: string) => {
      this.stats.wsRejected += 1;
      this.requestLog.push(`WS-REJECT ${status} ${msg} cookie=${req.headers.cookie ? "yes" : "no"} protocol=${String(req.headers["sec-websocket-protocol"] ?? "")} origin=${String(req.headers.origin ?? "")}`);
      socket.end(`HTTP/1.1 ${status} ${msg}\r\nContent-Length: 0\r\n\r\n`);
    };
    if (this.blockWebSocket) return reject(403, "Forbidden");
    const id = /^\/poll\/(\d+)$/.exec(new URL(req.url ?? "/", "http://x").pathname)?.[1];
    const sub = id ? this.subscriptions.get(id) : undefined;
    if (!sub) return reject(404, "Not Found");
    const cookie = parseCookies(req.headers.cookie).get("ABBCX");
    if (!cookie || !this.sessions.has(cookie)) return reject(401, "Unauthorized");
    const expected = this.dialect === "rws2" ? "rws_subscription" : "robapi2_subscription";
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim());
    if (!offered.includes(expected)) return reject(400, "Bad Request");
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${expected}\r\n\r\n`,
    );
    this.stats.wsUpgrades += 1;
    sub.sockets.add(socket);
    socket.on("data", (buf: Buffer) => {
      if ((buf[0]! & 0x0f) === 0x8) socket.end(Buffer.from([0x88, 0x00]));
    });
    socket.on("close", () => sub.sockets.delete(socket));
    socket.on("error", () => sub.sockets.delete(socket));
  }

  /** Pushes an event to every WebSocket subscribed to `uri`. */
  push(uri: string, cls: string, spans: Record<string, string>): void {
    const doc = XHTML(`<ul>${this.evLi(uri, cls, spans)}</ul>`);
    for (const s of this.subscriptions.values()) {
      if (!s.uris.includes(uri)) continue;
      for (const sock of s.sockets) sock.write(wsFrame(doc));
    }
  }
}
