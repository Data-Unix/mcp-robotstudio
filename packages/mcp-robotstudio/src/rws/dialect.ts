/**
 * RWS 1.0 (IRC5 / RobotWare 6) vs RWS 2.0 (OmniCore / RobotWare 7-8) route table.
 * Sources and verification status per row: referencias/temas/rws1-vs-rws2.md.
 * RWS 1.0 rows were checked live against RobotWare 6.16; RWS 2.0 rows come from
 * documentation and an open-source client and are covered by FakeRwsServer only.
 */
export type RwsProtocolDialect = "auto" | "rws1" | "rws2";
export type ResolvedDialect = Exclude<RwsProtocolDialect, "auto">;
export type MastershipDomain = "rapid" | "cfg";
export type ControllerDir = "HOME" | "TEMP";

export interface RwsRoutes {
  readonly dialect: ResolvedDialect;
  /** Accept header to send, or undefined for the controller default (XHTML). */
  readonly accept?: string;
  /** Content-Type for form-encoded POST bodies. */
  readonly formContentType: string;
  /** WebSocket subprotocol for /subscription. */
  readonly subscriptionProtocol: string;
  symbol(task: string, module: string, symbol: string): string;
  symbolSet(task: string, module: string, symbol: string): string;
  modules(task: string): string;
  execution(action: "start" | "stop" | "resetpp"): string;
  loadModule(task: string): string;
  saveModule(task: string, module: string): string;
  mastership(domain: MastershipDomain, action: "request" | "release"): string;
  /** Directory token: "$HOME"/"$TEMP" (RWS 1.0) or "HOME"/"TEMP" (RWS 2.0). */
  dirToken(dir: ControllerDir): string;
  file(dir: ControllerDir, name?: string): string;
  speedRatioSet(): string;
  pcp(task: string): string;
  signalSet(name: string): string;
  backup(): string;
}

const enc = encodeURIComponent;
const segs = (p: string): string =>
  p
    .split("/")
    .filter(Boolean)
    .map((s) => enc(s))
    .join("/");

export const RWS1_ROUTES: RwsRoutes = {
  dialect: "rws1",
  accept: undefined,
  formContentType: "application/x-www-form-urlencoded",
  subscriptionProtocol: "robapi2_subscription",
  symbol: (t, m, s) => `/rw/rapid/symbol/data/RAPID/${enc(t)}/${enc(m)}/${enc(s)}`,
  symbolSet: (t, m, s) => `/rw/rapid/symbol/data/RAPID/${enc(t)}/${enc(m)}/${enc(s)}?action=set`,
  // RW6: /rw/rapid/tasks/<t>/modules returns 404 (verified live).
  modules: (t) => `/rw/rapid/modules?task=${enc(t)}`,
  execution: (a) => `/rw/rapid/execution?action=${a}`,
  loadModule: (t) => `/rw/rapid/tasks/${enc(t)}?action=loadmod`,
  saveModule: (t, m) => `/rw/rapid/modules/${enc(m)}?task=${enc(t)}&action=save`,
  mastership: (d, a) => `/rw/mastership/${d}?action=${a}`,
  dirToken: (d) => `$${d}`,
  file: (d, n) => `/fileservice/$${d}${n ? `/${segs(n)}` : ""}`,
  speedRatioSet: () => "/rw/panel/speedratio?action=setspeedratio",
  pcp: (t) => `/rw/rapid/tasks/${enc(t)}/pcp`,
  signalSet: (n) => `/rw/iosystem/signals/${segs(n)}?action=set`,
  backup: () => "/ctrl/backup?action=backup",
};

export const RWS2_ROUTES: RwsRoutes = {
  dialect: "rws2",
  // XHTML v2.0 keeps the class-based parsers shared with RWS 1.0; hal+json;v=2.0
  // is the JSON alternative (plain application/json is rejected with 406).
  accept: "application/xhtml+xml;v=2.0",
  formContentType: "application/x-www-form-urlencoded;v=2.0",
  subscriptionProtocol: "rws_subscription",
  symbol: (t, m, s) => `/rw/rapid/symbol/RAPID/${enc(t)}/${enc(m)}/${enc(s)}/data`,
  symbolSet: (t, m, s) => `/rw/rapid/symbol/RAPID/${enc(t)}/${enc(m)}/${enc(s)}/data`,
  modules: (t) => `/rw/rapid/tasks/${enc(t)}/modules`,
  execution: (a) => `/rw/rapid/execution/${a}`,
  loadModule: (t) => `/rw/rapid/tasks/${enc(t)}/loadmod`,
  saveModule: (t, m) => `/rw/rapid/tasks/${enc(t)}/modules/${enc(m)}/save`,
  // RWS 2.0 collapses the rapid and cfg domains into "edit".
  mastership: (_d, a) => `/rw/mastership/edit/${a}`,
  dirToken: (d) => d,
  file: (d, n) => `/fileservice/${d}${n ? `/${segs(n)}` : ""}`,
  speedRatioSet: () => "/rw/panel/speedratio",
  pcp: (t) => `/rw/rapid/tasks/${enc(t)}/pcp`,
  signalSet: (n) => `/rw/iosystem/signals/${segs(n)}/set-value`,
  backup: () => "/ctrl/backup/create",
};

export function routesFor(dialect: ResolvedDialect): RwsRoutes {
  return dialect === "rws2" ? RWS2_ROUTES : RWS1_ROUTES;
}

/** Initial guess before the first challenge: https -> RWS 2.0, http -> RWS 1.0. */
export function guessDialectFromUrl(baseUrl: string): ResolvedDialect {
  return /^https:/i.test(baseUrl) ? "rws2" : "rws1";
}

/**
 * Dialect implied by a 401 challenge: Digest -> RWS 1.0, Basic -> RWS 2.0.
 * Returns undefined for anything else.
 */
export function dialectFromChallenge(wwwAuthenticate: string): ResolvedDialect | undefined {
  if (/(^|,\s*)Digest\s/i.test(wwwAuthenticate)) return "rws1";
  if (/^\s*Basic\b/i.test(wwwAuthenticate)) return "rws2";
  return undefined;
}

/** Subscription priority (ABB: 0 low, 1 medium, 2 high). */
export type SubscriptionPriority = 0 | 1 | 2;

/**
 * ABB: "A 'High' priority subscription is applicable only for persistent RAPID
 * variables and IO signals." Returns an error message or undefined when valid.
 */
export function validateSubscriptionPriority(uri: string, priority: number): string | undefined {
  if (priority !== 0 && priority !== 1 && priority !== 2) {
    return `priority must be 0, 1 or 2 (got ${priority}) for ${uri}`;
  }
  if (priority === 2 && !isHighPriorityResource(uri)) {
    return `priority 2 is only allowed for I/O signals and RAPID PERS symbols, not ${uri}`;
  }
  return undefined;
}

export function isHighPriorityResource(uri: string): boolean {
  return (
    /^\/rw\/iosystem\/signals\/.+;state$/.test(uri) ||
    /^\/rw\/rapid\/symbol\/(data\/RAPID|RAPID)\/.+;value$/.test(uri) ||
    /^\/rw\/rapid\/symbol\/RAPID\/.+\/data;value$/.test(uri)
  );
}
