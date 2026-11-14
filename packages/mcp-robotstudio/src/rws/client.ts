import {
  computeDigestAuthorization,
  type DigestChallenge,
  parseAuthenticateHeader,
  RwsError,
} from "./digest.js";
import {
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

  constructor(options: RwsClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:80").replace(/\/+$/, "");
    this.username = options.username ?? "Default User";
    this.password = options.password ?? "robotics";
    this.task = options.task ?? "T_ROB1";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.cookieStore = options.cookieStore;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.cnonceGenerator = options.cnonceGenerator;
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
  ): Promise<{ status: number; body: string }> {
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
  ): Promise<{ status: number; body: string }> {
    await this.ensureCookiesLoaded();

    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    let encodedBody: string | undefined;
    let contentType = options.contentType;

    if (typeof options.body === "string") {
      encodedBody = options.body;
      contentType ??= "text/plain;charset=utf-8";
    } else if (options.body) {
      encodedBody = new URLSearchParams(options.body).toString();
      contentType ??= "application/x-www-form-urlencoded";
    } else if (method === "POST" || method === "PUT") {
      encodedBody = "";
      contentType ??= "application/x-www-form-urlencoded";
    }

    // First try using existing session cookie (or cached Digest challenge if no cookie yet).
    let authHeader: string | undefined;
    if (this.cookies.size === 0 && this.lastChallenge) {
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

    return { status: response.status, body: text };
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
      `/rw/rapid/modules?task=${encodeURIComponent(task)}`,
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
      `/rw/rapid/symbol/data/RAPID/${encodeURIComponent(task)}/${encodeURIComponent(module)}/${encodeURIComponent(symbol)}`,
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
      `/rw/rapid/symbol/data/RAPID/${encodeURIComponent(task)}/${encodeURIComponent(module)}/${encodeURIComponent(symbol)}?action=set`,
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
      `/rw/iosystem/signals/${encodePathSegments(name)}?action=set`,
      { body: { lvalue } },
    );
    return {
      name,
      value: lvalue,
      statusCode: status,
      success: status === 200 || status === 201 || status === 204,
    };
  }

  protected async withRapidMastership<T>(fn: () => Promise<T>): Promise<T> {
    await this.request("POST", "/rw/mastership/rapid?action=request");
    try {
      return await fn();
    } finally {
      await this.request("POST", "/rw/mastership/rapid?action=release").catch(() => undefined);
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

    await this.request("PUT", `/fileservice/$HOME/${encodeURIComponent(baseName)}`, {
      body: input.content,
      contentType: "text/plain;v=2.0",
    });

    const loadRes = await this.withRapidMastership(() =>
      this.request("POST", `/rw/rapid/tasks/${encodeURIComponent(task)}?action=loadmod`, {
        body: {
          modulepath: `$HOME/${baseName}`,
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
      await this.withRapidMastership(() =>
        this.request("POST", "/rw/rapid/execution?action=resetpp"),
      );
    }

    const { status } = await this.request("POST", "/rw/rapid/execution?action=start", {
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

  async stopRapid(): Promise<{ statusCode: number; panel: PanelState }> {
    const { status } = await this.request("POST", "/rw/rapid/execution?action=stop", {
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
