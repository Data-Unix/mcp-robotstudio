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

export interface RwsExtensionSettings {
  host: string;
  port: number;
  task: string;
  username: string;
}

export const DEFAULT_SETTINGS: RwsExtensionSettings = {
  host: "127.0.0.1",
  port: 80,
  task: "T_ROB1",
  username: "Default User",
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

export type ExtensionRequest =
  | { action: "getDashboardData"; signalFilter?: string }
  | { action: "getSignals"; filter: string; limit?: number }
  | { action: "readSymbol"; module: string; symbol: string; task?: string }
  | { action: "checkConnection" };

export type ExtensionResponse =
  | { ok: true; data: DashboardPayload }
  | { ok: true; signals: IoSignalInfo[]; filter: string }
  | { ok: true; symbolResult: { task: string; module: string; symbol: string; value: string | null } }
  | { ok: true; connection: { baseUrl: string; system: SystemInfo; ctrlstate: string | null } }
  | { ok: false; error: string; code?: string; status?: number };

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

export function buildBaseUrl(settings: RwsExtensionSettings): string {
  const host = sanitizeHost(settings.host);
  const port = validatePort(settings.port);
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostPart}:${port}`;
}

export function buildOriginPattern(host: string): string {
  const clean = sanitizeHost(host).replace(/^\[|\]$/g, "");
  return `http://${clean}/*`;
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

  return { host, port, task, username };
}

export async function saveSettings(settings: RwsExtensionSettings): Promise<RwsExtensionSettings> {
  const normalized: RwsExtensionSettings = {
    host: sanitizeHost(settings.host),
    port: validatePort(settings.port),
    task: settings.task.trim() || DEFAULT_SETTINGS.task,
    username: settings.username.trim() || DEFAULT_SETTINGS.username,
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
