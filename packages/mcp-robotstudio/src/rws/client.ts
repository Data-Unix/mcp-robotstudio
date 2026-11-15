import {
  type ControllerDir,
  dialectFromChallenge,
  guessDialectFromUrl,
  type MastershipDomain,
  type ResolvedDialect,
  routesFor,
  type RwsProtocolDialect,
  type RwsRoutes,
} from "./dialect.js";
import {
  basicAuthorization,
  computeDigestAuthorization,
  type DigestChallenge,
  parseAuthenticateHeader,
  RwsError,
} from "./digest.js";
import {
  type ControllerFileInfo,
  parseFileListXml,
  parseGrantsXml,
  parsePcpXml,
  parseRmmpXml,
  parseSpeedRatioXml,
  parseSymbolPropertiesXml,
  type ProgramPointerPosition,
  type SymbolProperties,
  type EventLogEntry,
  type IoSignalInfo,
  type JointTargetInfo,
  type PanelState,
  parseCtrlStateXml,
  parseEventLogXml,
  parseExecutionXml,
  parseJointTargetXml,
  parseMastershipXml,
  parseModulesXml,
  parseOpModeXml,
  parseRobTargetXml,
  parseRwsErrorBody,
  parseSignalsListXml,
  parseSingleSignalXml,
  parseSymbolXml,
  parseSystemXml,
  parseTasksXml,
  type RapidModuleInfo,
  type RapidTaskInfo,
  type RobTargetInfo,
  type SystemInfo,
} from "./parsers.js";

export interface CookieStore {
  load(key: string): Promise<string | undefined>;
  save(key: string, cookieHeader: string): Promise<void>;
}

export interface RwsClientOptions {
  baseUrl?: string;
  username?: string;
  password?: string;
  task?: string;
  timeoutMs?: number;
  cookieStore?: CookieStore;
  fetchImpl?: typeof fetch;
  cnonceGenerator?: () => string;
  /**
   * "rws1" (IRC5/RW6, Digest over HTTP), "rws2" (OmniCore/RW7-8, Basic over HTTPS)
   * or "auto" (default): guessed from the URL scheme, then fixed by the first 401
   * challenge (Digest -> rws1, Basic over https -> rws2).
   */
  dialect?: RwsProtocolDialect;
}

export interface RwsResponse {
  status: number;
  body: string;
  location?: string;
}

export interface UserPrivileges {
  users: string[];
  rmmp: { privilege: string | null; heldByMe: boolean | null } | null;
  grants: string[];
  /** Endpoints that answered; missing ones are listed in `unavailable`. */
  unavailable: string[];
}

export interface ProgramPointerResult {
  task: string;
  programPointer: ProgramPointerPosition;
  motionPointer: ProgramPointerPosition;
}

export interface ControllerStateResult {
  baseUrl: string;
  task: string;
  system: SystemInfo;
  panel: PanelState;
  tasks: RapidTaskInfo[];
}

export interface LoadModuleInput {
  fileName: string;
  content: string;
  replace?: boolean;
  task?: string;
}

export interface LoadModuleResult {
  success: boolean;
  statusCode: number;
  task: string;
  file: string;
  moduleName: string;
  modules: string[];
  reason?: string;
  events: EventLogEntry[];
}

function encodePathSegments(pathValue: string): string {
  return pathValue
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

function extractSetCookies(headers: Headers): string[] {
  const maybeGetSetCookie = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof maybeGetSetCookie === "function") {
    return maybeGetSetCookie.call(headers);
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function parseCookieHeaderMap(cookieHeader: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (name) map.set(name, val);
  }
  return map;
}

function serializeCookieMap(map: Map<string, string>): string {
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

export class RwsReadOnlyClient {
  readonly baseUrl: string;
  readonly username: string;
  readonly task: string;
  readonly timeoutMs: number;

  private readonly password: string;
  private readonly cookieStore?: CookieStore;
  private readonly fetchImpl: typeof fetch;
  private readonly cnonceGenerator?: () => string;

  private readonly cookies = new Map<string, string>();
  private cookiesLoaded = false;
  private authInFlight: Promise<void> | null = null;
  private lastChallenge?: DigestChallenge;
  private nonceCount = 0;
  private useBasic = false;

  readonly requestedDialect: RwsProtocolDialect;
  private resolved: ResolvedDialect;

  constructor(options: RwsClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:80").replace(/\/+$/, "");
    this.username = options.username ?? "Default User";
    this.password = options.password ?? "robotics";
    this.task = options.task ?? "T_ROB1";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.cookieStore = options.cookieStore;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.cnonceGenerator = options.cnonceGenerator;
    this.requestedDialect = options.dialect ?? "auto";
    this.resolved =
      this.requestedDialect === "auto" ? guessDialectFromUrl(this.baseUrl) : this.requestedDialect;
    if (this.resolved === "rws2" && !this.isTls) {
      throw new RwsError("RWS 2.0 requires an https:// base URL (Basic credentials are never sent over HTTP)", {
        status: 400,
        rwsCode: "RWS2_REQUIRES_TLS",
        rwsMessage: "Use https:// for OmniCore controllers",
      });
    }
  }

  get isTls(): boolean {
    return /^https:/i.test(this.baseUrl);
  }

  /** Dialect in use (resolved from "auto" after the first challenge). */
  get dialect(): ResolvedDialect {
    return this.resolved;
  }

  get routes(): RwsRoutes {
    return routesFor(this.resolved);
  }

  /** Forces a GET /rw/system so "auto" settles on the controller's real dialect. */
  async detectDialect(): Promise<ResolvedDialect> {
    await this.request("GET", "/rw/system");
    return this.resolved;
  }

  get cookieStoreKey(): string {
    return `${this.baseUrl}|${this.username}`;
  }

  get currentCookieHeader(): string {
    return serializeCookieMap(this.cookies);
  }

  private async ensureCookiesLoaded(): Promise<void> {
    if (this.cookiesLoaded) return;
    this.cookiesLoaded = true;
    if (!this.cookieStore) return;
    const stored = await this.cookieStore.load(this.cookieStoreKey);
    if (stored) {
      for (const [k, v] of parseCookieHeaderMap(stored)) {
        this.cookies.set(k, v);
      }
    }
  }

  private async captureCookies(headers: Headers): Promise<void> {
    const setCookies = extractSetCookies(headers);
    if (setCookies.length === 0) return;
    let changed = false;
    for (const raw of setCookies) {
      const firstPart = raw.split(";")[0] ?? "";
      const eq = firstPart.indexOf("=");
      if (eq <= 0) continue;
      const name = firstPart.slice(0, eq).trim();
      const val = firstPart.slice(eq + 1).trim();
      if (name && this.cookies.get(name) !== val) {
        this.cookies.set(name, val);
        changed = true;
      }
    }
    if (changed && this.cookieStore) {
      await this.cookieStore.save(this.cookieStoreKey, serializeCookieMap(this.cookies));
    }
  }

  private async sendOnce(
    method: string,
    path: string,
    body: string | undefined,
    contentType: string | undefined,
    authorization?: string,
  ): Promise<Response> {
    const headers = new Headers();
    const accept = this.routes.accept;
    if (accept) {
      headers.set("Accept", accept);
    }
    if (contentType) {
      headers.set("Content-Type", contentType);
    }
    const cookieHeader = serializeCookieMap(this.cookies);
    if (cookieHeader) {
      headers.set("Cookie", cookieHeader);
    }
    if (authorization) {
      headers.set("Authorization", authorization);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : (body ?? ""),
        credentials: "include",
        signal: controller.signal,
      });
      await this.captureCookies(response.headers);
      return response;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new RwsError(`RWS request timeout after ${this.timeoutMs} ms (${method} ${path})`, {
          status: 408,
          rwsCode: "TIMEOUT",
          rwsMessage: `Timed out after ${this.timeoutMs} ms`,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async request(
    method: string,
    path: string,
    options: {
      body?: Record<string, string> | string;
      contentType?: string;
    } = {},
  ): Promise<RwsResponse> {
    while (this.authInFlight) {
      await this.authInFlight;
    }

    if (!this.cookiesLoaded || this.cookies.size === 0) {
      let releaseAuth!: () => void;
      this.authInFlight = new Promise<void>((resolve) => {
        releaseAuth = resolve;
      });
      try {
        return await this.executeRequest(method, path, options);
      } finally {
        this.authInFlight = null;
        releaseAuth();
      }
    }

    return await this.executeRequest(method, path, options);
  }

  private async executeRequest(
    method: string,
    path: string,
    options: {
      body?: Record<string, string> | string;
      contentType?: string;
    } = {},
  ): Promise<RwsResponse> {
    await this.ensureCookiesLoaded();

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    let encodedBody: string | undefined;
    let contentType = options.contentType;

    if (typeof options.body === "string") {
      encodedBody = options.body;
      contentType ??= "text/plain;charset=utf-8";
    } else if (options.body) {
      encodedBody = new URLSearchParams(options.body).toString();
      contentType ??= this.routes.formContentType;
    } else if (method === "POST" || method === "PUT") {
      encodedBody = "";
      contentType ??= this.routes.formContentType;
    }

    // First try using existing session cookie (or cached Digest challenge if no cookie yet).
    let authHeader: string | undefined;
    if (this.cookies.size === 0 && this.useBasic) {
      authHeader = basicAuthorization(this.username, this.password);
    } else if (this.cookies.size === 0 && this.lastChallenge) {
      this.nonceCount += 1;
      authHeader = computeDigestAuthorization({
        username: this.username,
        password: this.password,
        method,
        uri: normalizedPath,
        challenge: this.lastChallenge,
        nc: this.nonceCount,
        cnonce: this.cnonceGenerator?.(),
      }).header;
    }

    let response = await this.sendOnce(method, normalizedPath, encodedBody, contentType, authHeader);

    // Handle 401 Digest challenge (initial auth, expired cookie, or stale nonce).
    if (response.status === 401) {
      const wwwAuth = response.headers.get("www-authenticate") ?? "";
      const implied = dialectFromChallenge(wwwAuth);

      // RWS 2.0: Basic is accepted ONLY over TLS and only when not forced to rws1.
      if (implied === "rws2" && this.isTls && this.requestedDialect !== "rws1") {
        this.resolved = "rws2";
        this.useBasic = true;
        response = await this.sendOnce(
          method,
          normalizedPath,
          encodedBody,
          contentType ?? (encodedBody !== undefined ? this.routes.formContentType : undefined),
          basicAuthorization(this.username, this.password),
        );
        return await this.finish(response);
      }
      if (implied === "rws1" && this.requestedDialect === "auto") {
        this.resolved = "rws1";
      }

      // Digest path; parseAuthenticateHeader rejects Basic (cleartext over HTTP).
      const challenge = parseAuthenticateHeader(wwwAuth);
      this.lastChallenge = challenge;
      this.nonceCount = 1;

      const digest = computeDigestAuthorization({
        username: this.username,
        password: this.password,
        method,
        uri: normalizedPath,
        challenge,
        nc: this.nonceCount,
        cnonce: this.cnonceGenerator?.(),
      });

      response = await this.sendOnce(method, normalizedPath, encodedBody, contentType, digest.header);

      // If the server responds 401 again with stale="TRUE", retry once with the fresh nonce.
      if (response.status === 401) {
        const retryWwwAuth = response.headers.get("www-authenticate") ?? "";
        if (retryWwwAuth) {
          const staleChallenge = parseAuthenticateHeader(retryWwwAuth);
          if (staleChallenge.stale) {
            this.lastChallenge = staleChallenge;
            this.nonceCount = 1;
            const retryDigest = computeDigestAuthorization({
              username: this.username,
              password: this.password,
              method,
              uri: normalizedPath,
              challenge: staleChallenge,
              nc: this.nonceCount,
              cnonce: this.cnonceGenerator?.(),
            });
            response = await this.sendOnce(
              method,
              normalizedPath,
              encodedBody,
              contentType,
              retryDigest.header,
            );
          }
        }
      }
    }

    return await this.finish(response);
  }

  private async finish(response: Response): Promise<RwsResponse> {
    const text = response.status === 204 ? "" : await response.text();
    if (!response.ok && response.status !== 204) {
      const detail = parseRwsErrorBody(text);
      const summary = [
        `RWS HTTP ${response.status}`,
        detail.code ? `code=${detail.code}` : undefined,
        detail.msg,
      ]
        .filter(Boolean)
        .join(": ");
      throw new RwsError(summary, {
        status: response.status,
        rwsCode: detail.code,
        rwsMessage: detail.msg,
        rawBody: text,
      });
    }

    const location = response.headers.get("location") ?? undefined;
    return { status: response.status, body: text, ...(location ? { location } : {}) };
  }

  async getSystemInfo(): Promise<SystemInfo> {
    const { body } = await this.request("GET", "/rw/system");
    return parseSystemXml(body);
  }

  async getPanelState(): Promise<PanelState> {
    const [ctrlRes, opRes, execRes] = await Promise.all([
      this.request("GET", "/rw/panel/ctrlstate"),
      this.request("GET", "/rw/panel/opmode"),
      this.request("GET", "/rw/rapid/execution"),
    ]);
    return {
      ...parseCtrlStateXml(ctrlRes.body),
      ...parseOpModeXml(opRes.body),
      ...parseExecutionXml(execRes.body),
    };
  }

  async getTasks(): Promise<{ tasks: RapidTaskInfo[] }> {
    const { body } = await this.request("GET", "/rw/rapid/tasks");
    return parseTasksXml(body);
  }

  async getControllerState(): Promise<ControllerStateResult> {
    const [system, panel, tasksRes] = await Promise.all([
      this.getSystemInfo(),
      this.getPanelState(),
      this.getTasks(),
    ]);
    return {
      baseUrl: this.baseUrl,
      task: this.task,
      system,
      panel,
      tasks: tasksRes.tasks,
    };
  }

  async listModules(task = this.task): Promise<{
    task: string;
    modules: string[];
    items: RapidModuleInfo[];
  }> {
    // RW6 RWS 1.0 uses /rw/rapid/modules?task=... (RW7 /tasks/<t>/modules returns 404).
    const { body } = await this.request(
      "GET",
      this.routes.modules(task),
    );
    return {
      task,
      ...parseModulesXml(body),
    };
  }

  async readRapidSymbol(
    module: string,
    symbol: string,
    task = this.task,
  ): Promise<{ task: string; module: string; symbol: string; value: string | null }> {
    const { body } = await this.request(
      "GET",
      this.routes.symbol(task, module, symbol),
    );
    return {
      task,
      module,
      symbol,
      ...parseSymbolXml(body),
    };
  }

  async listSignals(filter = "", limit = 100): Promise<{
    filter: string;
    signals: IoSignalInfo[];
  }> {
    const pageSize = Math.min(Math.max(1, limit), 100);
    const needle = filter.trim().toLowerCase();
    const collected: IoSignalInfo[] = [];
    let start = 0;

    while (start <= 5000) {
      const { body } = await this.request(
        "GET",
        `/rw/iosystem/signals?start=${start}&limit=${pageSize}`,
      );
      const parsed = parseSignalsListXml(body);
      for (const sig of parsed.signals) {
        if (!needle || sig.name.toLowerCase().includes(needle)) {
          collected.push(sig);
          if (collected.length >= limit) {
            return { filter, signals: collected };
          }
        }
      }
      if (!parsed.hasNext || parsed.signals.length < pageSize) {
        break;
      }
      start += pageSize;
    }

    return { filter, signals: collected };
  }

  async readSignal(name: string): Promise<IoSignalInfo> {
    const { body } = await this.request(
      "GET",
      `/rw/iosystem/signals/${encodePathSegments(name)}`,
    );
    return parseSingleSignalXml(body, name);
  }

  async getEventLog(limit = 10, domain = 0): Promise<{ domain: number; events: EventLogEntry[] }> {
    const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const { body } = await this.request(
      "GET",
      `/rw/elog/${Math.floor(domain)}?lang=en&lim=${safeLimit}`,
    );
    return {
      domain: Math.floor(domain),
      ...parseEventLogXml(body, safeLimit),
    };
  }

  async getJoints(mechunit = "ROB_1"): Promise<{ mechunit: string } & JointTargetInfo> {
    const { body } = await this.request(
      "GET",
      `/rw/motionsystem/mechunits/${encodeURIComponent(mechunit)}/jointtarget`,
    );
    return {
      mechunit,
      ...parseJointTargetXml(body),
    };
  }

  async getTcp(
    tool = "tool0",
    wobj = "wobj0",
    mechunit = "ROB_1",
    coordinate = "Wobj",
  ): Promise<{ mechunit: string; tool: string; wobj: string; coordinate: string } & RobTargetInfo> {
    const qs = new URLSearchParams({ tool, wobj, coordinate }).toString();
    const { body } = await this.request(
      "GET",
      `/rw/motionsystem/mechunits/${encodeURIComponent(mechunit)}/robtarget?${qs}`,
    );
    return {
      mechunit,
      tool,
      wobj,
      coordinate,
      ...parseRobTargetXml(body),
    };
  }

  async getMastership(): Promise<{ domains: string[] }> {
    const { body } = await this.request("GET", "/rw/mastership");
    return parseMastershipXml(body);
  }

  /** GET /rw/rapid/tasks/<task>/pcp. With PP unset RW6 returns error -1073442809 per pointer. */
  async getProgramPointer(task = this.task): Promise<ProgramPointerResult> {
    const { body } = await this.request("GET", this.routes.pcp(task));
    return { task, ...parsePcpXml(body) };
  }

  /**
   * GET /rw/motionsystem/mechunits/<unit>: active tool/wobj and the SMB
   * synchronization status ("Synchronized" when revolution counters are valid;
   * verified live on RW 6.16). RW6 has no ?resource=calibration (400).
   */
  async getMechunitStatus(mechunit = "ROB_1"): Promise<{
    mechunit: string;
    status: string | null;
    mode: string | null;
    tool: string | null;
    wobj: string | null;
  }> {
    const { body } = await this.request("GET", `/rw/motionsystem/mechunits/${encodeURIComponent(mechunit)}`);
    const span = (c: string) => new RegExp(`<span class="${c}">([^<]*)<`).exec(body)?.[1]?.trim() ?? null;
    return { mechunit, status: span("status"), mode: span("mode"), tool: span("tool-name"), wobj: span("wobj-name") };
  }

  async getSpeedRatio(): Promise<{ speedRatio: number | null }> {
    const { body } = await this.request("GET", "/rw/panel/speedratio");
    return parseSpeedRatioXml(body);
  }

  /** RWS 1.0: /rw/rapid/symbol/properties/RAPID/<task>/<module>/<symbol> (symtyp per|var|con). */
  async getSymbolProperties(module: string, symbol: string, task = this.task): Promise<SymbolProperties> {
    const enc = encodeURIComponent;
    const path =
      this.dialect === "rws2"
        ? `/rw/rapid/symbol/RAPID/${enc(task)}/${enc(module)}/${enc(symbol)}/properties`
        : `/rw/rapid/symbol/properties/RAPID/${enc(task)}/${enc(module)}/${enc(symbol)}`;
    const { body } = await this.request("GET", path);
    return parseSymbolPropertiesXml(body);
  }

  async listFiles(dir: ControllerDir = "TEMP"): Promise<{ dir: string; files: ControllerFileInfo[] }> {
    const { body } = await this.request("GET", this.routes.file(dir));
    return { dir: this.routes.dirToken(dir), ...parseFileListXml(body) };
  }

  async readFile(dir: ControllerDir, name: string): Promise<string> {
    const { body } = await this.request("GET", this.routes.file(dir, name));
    return body;
  }

  /**
   * UAS view of the logged-in RWS user: /users, /users/rmmp and /users/grants.
   * Each endpoint is optional; failures are reported in `unavailable`.
   */
  async getUserPrivileges(): Promise<UserPrivileges> {
    const unavailable: string[] = [];
    const users = await this.request("GET", "/users")
      .then((r) => [...r.body.matchAll(/<span class="name">([^<]*)</g)].map((m) => m[1]!.trim()))
      .catch(() => {
        unavailable.push("/users");
        return [] as string[];
      });
    const rmmp = await this.request("GET", "/users/rmmp")
      .then((r) => parseRmmpXml(r.body))
      .catch(() => {
        unavailable.push("/users/rmmp");
        return null;
      });
    const grants = await this.request("GET", "/users/grants")
      .then((r) => parseGrantsXml(r.body).grants)
      .catch(() => {
        unavailable.push("/users/grants");
        return [] as string[];
      });
    return { users, rmmp, grants, unavailable };
  }

  /**
   * Extracts the live module text from controller RAM: action=save to TEMP,
   * GET the file, then DELETE it (always, also on error). The saved file name
   * is not predictable on RW 6.16 (verified live: a 7-char name is saved as
   * "<name>.mod", longer names are cut to 7 chars without extension), so the
   * file is located by listing TEMP after the save.
   */
  async readModuleSource(module: string, task = this.task): Promise<{
    task: string;
    module: string;
    source: string;
    tempFile: string;
    cleanedUp: boolean;
  }> {
    const rand = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(2)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const base = `mcp${rand}`; // 7 chars, never truncated
    await this.request("POST", this.routes.saveModule(task, module), {
      body: { name: base, path: this.routes.dirToken("TEMP") },
    });
    const listed = await this.listFiles("TEMP");
    const tempName =
      listed.files.find((f) => f.kind === "file" && (f.name === `${base}.mod` || f.name === base))?.name ??
      listed.files.find((f) => f.kind === "file" && f.name.startsWith(base))?.name;
    if (!tempName) {
      throw new RwsError(`Module ${module} was not saved to TEMP (no ${base}* file found)`, {
        status: 500,
        rwsCode: "SAVE_NOT_FOUND",
        rwsMessage: `files in TEMP: ${listed.files.map((f) => f.name).join(", ")}`,
      });
    }
    const tempFile = `${this.routes.dirToken("TEMP")}/${tempName}`;
    const read = await this.readFile("TEMP", tempName).then(
      (source) => ({ source }),
      (error: unknown) => ({ error }),
    );
    const cleanedUp = await this.request("DELETE", this.routes.file("TEMP", tempName)).then(
      () => true,
      () => false,
    );
    if ("error" in read) throw read.error;
    if (!cleanedUp) {
      // Surface leftover garbage instead of hiding it.
      throw new RwsError(`Temporary file ${tempFile} could not be deleted`, {
        status: 500,
        rwsCode: "TEMP_CLEANUP_FAILED",
        rwsMessage: `Delete ${tempFile} manually`,
      });
    }
    return { task, module, source: read.source, tempFile, cleanedUp };
  }
}

export class RwsClient extends RwsReadOnlyClient {
  async writeRapidSymbol(
    module: string,
    symbol: string,
    value: string,
    task = this.task,
  ): Promise<{
    task: string;
    module: string;
    symbol: string;
    value: string;
    statusCode: number;
    success: boolean;
  }> {
    const { status } = await this.request(
      "POST",
      this.routes.symbolSet(task, module, symbol),
      { body: { value } },
    );
    return {
      task,
      module,
      symbol,
      value,
      statusCode: status,
      success: status === 200 || status === 201 || status === 204,
    };
  }

  async setSignal(
    name: string,
    value: string | number,
  ): Promise<{ name: string; value: string; statusCode: number; success: boolean }> {
    const lvalue = String(value);
    const { status } = await this.request(
      "POST",
      this.routes.signalSet(name),
      { body: { lvalue } },
    );
    return {
      name,
      value: lvalue,
      statusCode: status,
      success: status === 200 || status === 201 || status === 204,
    };
  }

  protected async withMastership<T>(fn: () => Promise<T>, domain: MastershipDomain = "rapid"): Promise<T> {
    await this.request("POST", this.routes.mastership(domain, "request"));
    try {
      return await fn();
    } finally {
      await this.request("POST", this.routes.mastership(domain, "release")).catch(() => undefined);
    }
  }

  async loadModule(input: LoadModuleInput): Promise<LoadModuleResult> {
    const task = input.task ?? this.task;
    const replace = input.replace ?? true;
    const baseName = input.fileName.replace(/\\/g, "/").split("/").pop() ?? "";
    if (!baseName || baseName === "." || baseName === ".." || /[\\/:*?"<>|]/.test(baseName)) {
      throw new RwsError(`Invalid RAPID module filename: ${input.fileName}`, {
        status: 400,
        rwsCode: "INVALID_FILENAME",
        rwsMessage: "fileName must be a plain filename without path separators",
      });
    }

    const beforeElog = await this.getEventLog(5, 0);
    const beforeTop = beforeElog.events[0];
    const eventSig = (ev: EventLogEntry | undefined): string =>
      ev ? `${ev.code ?? ""}|${ev.time ?? ""}|${ev.title ?? ""}|${ev.desc}` : "";
    const beforeTopSig = eventSig(beforeTop);

    await this.request("PUT", this.routes.file("HOME", baseName), {
      body: input.content,
      contentType: "text/plain;v=2.0",
    });

    const loadRes = await this.withMastership(() =>
      this.request("POST", this.routes.loadModule(task), {
        body: {
          modulepath: `${this.routes.dirToken("HOME")}/${baseName}`,
          replace: replace ? "true" : "false",
        },
      }),
    );

    // RWS returns 204 No Content even when the RAPID file has syntax errors.
    // Confirm actual load status by checking the module list and any NEW event log entries.
    const declaredMatch = /^\s*MODULE\s+([A-Za-z0-9_]+)/im.exec(input.content);
    const moduleName = declaredMatch?.[1] ?? baseName.replace(/\.[^.]+$/, "");

    const [modList, elog] = await Promise.all([
      this.listModules(task),
      this.getEventLog(6, 0),
    ]);

    const prevIdx = beforeTopSig
      ? elog.events.findIndex((ev) => eventSig(ev) === beforeTopSig)
      : -1;
    const newEvents = prevIdx >= 0 ? elog.events.slice(0, prevIdx) : elog.events;

    const recentErrors = newEvents.filter(
      (ev) =>
        ev.type === "3" ||
        (ev.title ?? "").toLowerCase().includes("error") ||
        ev.desc.toLowerCase().includes("syntax"),
    );
    const hasLoadError = recentErrors.some(
      (ev) =>
        ev.title === "Load error" ||
        ev.title === "Errors in RAPID program" ||
        ev.desc.toLowerCase().includes("syntax"),
    );

    const present = modList.modules.some(
      (m) => m.toLowerCase() === moduleName.toLowerCase(),
    );

    if (!present || hasLoadError) {
      return {
        success: false,
        statusCode: loadRes.status,
        task,
        file: baseName,
        moduleName,
        modules: modList.modules,
        reason: present
          ? "RAPID load errors detected in controller event log"
          : "module not present after load (RAPID syntax error?)",
        events: recentErrors.slice(0, 3),
      };
    }

    return {
      success: true,
      statusCode: loadRes.status,
      task,
      file: baseName,
      moduleName,
      modules: modList.modules,
      events: elog.events.slice(0, 3),
    };
  }

  async startRapid(options: {
    cycle?: "forever" | "once" | "asis";
    resetPp?: boolean;
  } = {}): Promise<{
    statusCode: number;
    cycle: string;
    resetPp: boolean;
    panel: PanelState;
  }> {
    const cycle = options.cycle ?? "forever";
    const resetPp = options.resetPp ?? false;

    if (resetPp) {
      await this.withMastership(() =>
        this.request("POST", this.routes.execution("resetpp")),
      );
    }

    const { status } = await this.request("POST", this.routes.execution("start"), {
      body: {
        regain: "continue",
        execmode: "continue",
        cycle,
        condition: "none",
        stopatbp: "disabled",
        alltaskbytsp: "false",
      },
    });
    const panel = await this.getPanelState();
    return {
      statusCode: status,
      cycle,
      resetPp,
      panel,
    };
  }

  async setSpeedRatio(ratio: number): Promise<{ statusCode: number; speedRatio: number | null }> {
    if (!Number.isInteger(ratio) || ratio < 0 || ratio > 100) {
      throw new RwsError(`speed ratio must be an integer 0..100 (got ${ratio})`, {
        status: 400,
        rwsCode: "INVALID_SPEED_RATIO",
        rwsMessage: "speed ratio out of range",
      });
    }
    const { status } = await this.request("POST", this.routes.speedRatioSet(), {
      body: { "speed-ratio": String(ratio) },
    });
    const { speedRatio } = await this.getSpeedRatio();
    return { statusCode: status, speedRatio };
  }

  async resetProgramPointer(): Promise<{ statusCode: number }> {
    const { status } = await this.withMastership(() =>
      this.request("POST", this.routes.execution("resetpp")),
    );
    return { statusCode: status };
  }

  async deleteFile(dir: ControllerDir, name: string): Promise<{ statusCode: number }> {
    const { status } = await this.request("DELETE", this.routes.file(dir, name));
    return { statusCode: status };
  }

  /**
   * POST /ctrl/backup?action=backup with backup=$TEMP/<dir>. Only TEMP is
   * accepted (never HOME). RWS answers 202 + Location: /progress/<id>.
   */
  async triggerBackup(dirName: string, waitMs = 0): Promise<{
    statusCode: number;
    backupPath: string;
    progress?: string;
    state?: string;
  }> {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(dirName)) {
      throw new RwsError(`Invalid backup directory name: ${dirName}`, {
        status: 400,
        rwsCode: "INVALID_BACKUP_DIR",
        rwsMessage: "Use 1-32 chars [A-Za-z0-9_-]; the backup always goes under TEMP",
      });
    }
    const backupPath = `${this.routes.dirToken("TEMP")}/${dirName}`;
    // RW 6.16 (verified live): the body must be a fileservice URL path
    // ("/fileservice/$TEMP/<dir>"); the manual's "$TEMP/<dir>" answers 400
    // "Invalid File Service path".
    const res = await this.request("POST", this.routes.backup(), {
      body: { backup: this.routes.file("TEMP", dirName) },
    });
    const progress = res.location ? new URL(res.location, this.baseUrl).pathname : undefined;
    let state: string | undefined;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      // RW6: /ctrl/backup?action=backupstate -> "Init State" | ... | "Backup Ready"
      const body = (await this.request("GET", "/ctrl/backup?action=backupstate").catch((e: RwsError) => ({ body: e.rawBody ?? "" }))).body;
      state = /<span class="backup state">([^<]*)</.exec(body)?.[1];
      if (state && /ready|error|fail/i.test(state)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    return { statusCode: res.status, backupPath, ...(progress ? { progress } : {}), ...(state ? { state } : {}) };
  }

  async stopRapid(): Promise<{ statusCode: number; panel: PanelState }> {
    const { status } = await this.request("POST", this.routes.execution("stop"), {
      body: {
        stopmode: "stop",
        usetsp: "normal",
      },
    });
    const panel = await this.getPanelState();
    return {
      statusCode: status,
      panel,
    };
  }
}
