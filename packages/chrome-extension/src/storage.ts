import type {
  ControllerStateResult,
  CookieStore,
  EventLogEntry,
  IoSignalInfo,
  JointTargetInfo,
  RapidModuleInfo,
  RobTargetInfo,
  SystemInfo,
} from "mcp-robotstudio/rws";

export type ExtensionDialect = "rws1" | "rws2";

export interface FleetEntry {
  name: string;
  host: string;
  port: number;
  dialect: ExtensionDialect;
}

export interface RwsExtensionSettings {
  host: string;
  port: number;
  task: string;
  username: string;
  /** rws1 = IRC5/RW6 over http + Digest; rws2 = OmniCore over https + Basic */
  dialect?: ExtensionDialect;
  /** PRO fleet dashboard: extra controllers (same credentials) */
  fleet?: FleetEntry[];
}

export const DEFAULT_SETTINGS: RwsExtensionSettings = {
  host: "127.0.0.1",
  port: 80,
  task: "T_ROB1",
  username: "Default User",
  dialect: "rws1",
  fleet: [],
};

export const DEFAULT_VIRTUAL_PASSWORD = "robotics";

const LOCAL_SETTINGS_KEY = "rwsSettings";
const SESSION_PASSWORD_KEY = "rwsPassword";
const SESSION_COOKIES_KEY = "rwsSessionCookies";

export interface DashboardPayload {
  baseUrl: string;
  isLoopback: boolean;
  controller: ControllerStateResult;
  modules: { modules: string[]; items: RapidModuleInfo[] };
  signals: { signals: IoSignalInfo[]; filter: string };
  events: EventLogEntry[];
  joints?: JointTargetInfo;
  tcp?: RobTargetInfo & { mechunit: string; tool: string; wobj: string };
}

/** Free requests: read-only, one controller. */
export type FreeRequest =
  | { action: "getDashboardData"; signalFilter?: string }
  | { action: "getSignals"; filter: string; limit?: number }
  | { action: "readSymbol"; module: string; symbol: string; task?: string }
  | { action: "checkConnection" }
  | { action: "getLicense" }
  | { action: "activateLicense"; token: string }
  | { action: "deactivateLicense" }
  | { action: "getWriteMode" }
  | { action: "setWriteMode"; enabled: boolean };

/** PRO reads (license checked in the background). */
export type ProReadRequest =
  | { action: "getTelemetryPro"; tool?: string; wobj?: string }
  | { action: "captureForensic"; contextLines?: number }
  | { action: "readModuleSource"; module: string }
  | { action: "getFleet" }
  | { action: "getStorePathCert"; module: string; stopSymbol: string; returnSymbol: string }
  | { action: "getLiveAudit" }
  | { action: "startScope"; resources: Array<{ uri: string; priority: 0 | 1 | 2 }>; tcpPollMs?: number }
  | { action: "stopScope" };

/** PRO writes: also require the session write mode (off by default, cleared when the browser closes). */
export type ProWriteRequest =
  | { action: "setSpeedRatio"; ratio: number }
  | { action: "writeRecipe"; module: string; symbol: string; value: string; deltaMaxMm?: number; tool?: string }
  | { action: "loadModuleSafe"; fileName: string; content: string }
  | { action: "triggerBackup"; dirName: string };

export type ExtensionRequest = FreeRequest | ProReadRequest | ProWriteRequest;

export const PRO_READ_ACTIONS = new Set<ExtensionRequest["action"]>([
  "getTelemetryPro",
  "captureForensic",
  "readModuleSource",
  "getFleet",
  "getStorePathCert",
  "getLiveAudit",
  "startScope",
  "stopScope",
]);
export const PRO_WRITE_ACTIONS = new Set<ExtensionRequest["action"]>(["setSpeedRatio", "writeRecipe", "loadModuleSafe", "triggerBackup"]);

export type ExtensionResponse =
  | { ok: true; data: DashboardPayload }
  | { ok: true; signals: IoSignalInfo[]; filter: string }
  | { ok: true; symbolResult: { task: string; module: string; symbol: string; value: string | null } }
  | { ok: true; connection: { baseUrl: string; system: SystemInfo; ctrlstate: string | null } }
  | { ok: true; result: unknown }
  | { ok: false; error: string; code?: string; status?: number; proRequired?: boolean; writeModeRequired?: boolean };

const SESSION_WRITE_KEY = "writeModeEnabled";

export async function loadWriteMode(): Promise<boolean> {
  if (!chrome.storage?.session) return false;
  const res = await chrome.storage.session.get(SESSION_WRITE_KEY);
  return res[SESSION_WRITE_KEY] === true;
}

export async function saveWriteMode(enabled: boolean): Promise<void> {
  if (!chrome.storage?.session) return;
  await ensureTrustedSessionAccess();
  await chrome.storage.session.set({ [SESSION_WRITE_KEY]: enabled });
}

export function sanitizeHost(rawHost: string): string {
  const trimmed = rawHost.trim();
  if (!trimmed) {
    throw new Error("El host no puede estar vacio.");
  }
  if (/^[a-z]+:\/\//i.test(trimmed) || /[\s/?#@]/.test(trimmed)) {
    throw new Error("Introduzca unicamente el host o IP (sin esquema ni rutas), por ejemplo 127.0.0.1.");
  }
  return trimmed;
}

export function validatePort(rawPort: number): number {
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
    throw new Error("El puerto RWS debe ser un entero entre 1 y 65535.");
  }
  return rawPort;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function schemeFor(dialect: ExtensionDialect | undefined): "http" | "https" {
  return dialect === "rws2" ? "https" : "http";
}

export function buildBaseUrl(settings: Pick<RwsExtensionSettings, "host" | "port" | "dialect">): string {
  const host = sanitizeHost(settings.host);
  const port = validatePort(settings.port);
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${schemeFor(settings.dialect)}://${hostPart}:${port}`;
}

export function buildOriginPattern(host: string, dialect?: ExtensionDialect): string {
  const clean = sanitizeHost(host).replace(/^\[|\]$/g, "");
  return `${schemeFor(dialect)}://${clean}/*`;
}

export function sanitizeFleet(raw: unknown): FleetEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FleetEntry[] = [];
  for (const e of raw.slice(0, 16)) {
    const r = e as Partial<FleetEntry>;
    try {
      out.push({
        name: String(r.name ?? "").trim().slice(0, 32) || `celda-${out.length + 1}`,
        host: sanitizeHost(String(r.host ?? "")),
        port: validatePort(Number(r.port)),
        dialect: r.dialect === "rws2" ? "rws2" : "rws1",
      });
    } catch {
      // skip invalid entries
    }
  }
  return out;
}

export async function ensureTrustedSessionAccess(): Promise<void> {
  const sessionArea = chrome.storage?.session;
  if (!sessionArea || typeof sessionArea.setAccessLevel !== "function") {
    return;
  }
  try {
    await sessionArea.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // Non-fatal on environments that restrict setAccessLevel outside background
  }
}

export async function loadSettings(): Promise<RwsExtensionSettings> {
  const stored = await chrome.storage.local.get(LOCAL_SETTINGS_KEY);
  const raw = (stored[LOCAL_SETTINGS_KEY] ?? {}) as Partial<RwsExtensionSettings>;
  const host = typeof raw.host === "string" && raw.host.trim() ? raw.host.trim() : DEFAULT_SETTINGS.host;
  const portNum = Number(raw.port);
  const port = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535 ? portNum : DEFAULT_SETTINGS.port;
  const task = typeof raw.task === "string" && raw.task.trim() ? raw.task.trim() : DEFAULT_SETTINGS.task;
  const username =
    typeof raw.username === "string" && raw.username.trim()
      ? raw.username.trim()
      : DEFAULT_SETTINGS.username;

  const dialect: ExtensionDialect = raw.dialect === "rws2" ? "rws2" : "rws1";
  return { host, port, task, username, dialect, fleet: sanitizeFleet(raw.fleet) };
}

export async function saveSettings(settings: RwsExtensionSettings): Promise<RwsExtensionSettings> {
  const normalized: RwsExtensionSettings = {
    host: sanitizeHost(settings.host),
    port: validatePort(settings.port),
    task: settings.task.trim() || DEFAULT_SETTINGS.task,
    username: settings.username.trim() || DEFAULT_SETTINGS.username,
    dialect: settings.dialect === "rws2" ? "rws2" : "rws1",
    fleet: sanitizeFleet(settings.fleet),
  };
  await chrome.storage.local.set({ [LOCAL_SETTINGS_KEY]: normalized });
  return normalized;
}

export async function loadSessionPassword(): Promise<string> {
  if (!chrome.storage?.session) {
    return DEFAULT_VIRTUAL_PASSWORD;
  }
  const res = await chrome.storage.session.get(SESSION_PASSWORD_KEY);
  const val = res[SESSION_PASSWORD_KEY];
  return typeof val === "string" ? val : DEFAULT_VIRTUAL_PASSWORD;
}

export async function saveSessionPassword(password: string): Promise<void> {
  if (!chrome.storage?.session) {
    return;
  }
  await ensureTrustedSessionAccess();
  await chrome.storage.session.set({ [SESSION_PASSWORD_KEY]: password });
}

export class SessionCookieStore implements CookieStore {
  async load(key: string): Promise<string | undefined> {
    if (!chrome.storage?.session) return undefined;
    const data = await chrome.storage.session.get(SESSION_COOKIES_KEY);
    const map = (data[SESSION_COOKIES_KEY] ?? {}) as Record<string, string>;
    return typeof map[key] === "string" ? map[key] : undefined;
  }

  async save(key: string, cookieHeader: string): Promise<void> {
    if (!chrome.storage?.session) return;
    await ensureTrustedSessionAccess();
    const data = await chrome.storage.session.get(SESSION_COOKIES_KEY);
    const map = { ...((data[SESSION_COOKIES_KEY] ?? {}) as Record<string, string>) };
    map[key] = cookieHeader;
    await chrome.storage.session.set({ [SESSION_COOKIES_KEY]: map });
  }
}
