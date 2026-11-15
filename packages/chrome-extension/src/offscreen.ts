/**
 * Offscreen document: owns the single RWS WebSocket subscription (the MV3
 * service worker may be stopped after 30 s idle) and the TCP poll, and
 * broadcasts samples to the panel on channel "scope". Reconnection is ordered:
 * the old subscription is deleted before a new one is created, with backoff,
 * so the controller session / WebSocket limits are never exceeded.
 */
import { RwsReadOnlyClient, RwsSubscriptionClient, type SubscriptionResource } from "mcp-robotstudio/rws";

interface ScopeConfig {
  baseUrl: string;
  username: string;
  password: string;
  task: string;
  dialect: "rws1" | "rws2";
  resources: SubscriptionResource[];
  tcpPollMs: number;
}

let client: RwsReadOnlyClient | undefined;
let sub: RwsSubscriptionClient | undefined;
let tcpTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let backoffMs = 1000;
let running = false;

const emit = (payload: Record<string, unknown>) =>
  void chrome.runtime.sendMessage({ channel: "scope", t: performance.timeOrigin + performance.now(), ...payload }).catch(() => undefined);

/** XHTML event parser based on DOMParser (the reason this offscreen document exists). */
function parseWithDom(xml: string): Array<{ uri: string; values: Record<string, string> }> {
  const doc = new DOMParser().parseFromString(xml, "application/xhtml+xml");
  const out: Array<{ uri: string; values: Record<string, string> }> = [];
  // RW 6.16: a RAPID symbol event carries its value in the next sibling <li class="rap-data">.
  for (const li of Array.from(doc.getElementsByTagName("li"))) {
    const isEvent = /-ev$/.test(li.getAttribute("class") ?? "");
    const values: Record<string, string> = {};
    for (const s of Array.from(li.getElementsByTagName("span"))) {
      const k = s.getAttribute("class");
      if (k && !(k in values)) values[k] = (s.textContent ?? "").trim();
    }
    if (!isEvent) {
      const last = out[out.length - 1];
      if (last) for (const [k, v] of Object.entries(values)) if (!(k in last.values)) last.values[k] = v;
      continue;
    }
    const self = Array.from(li.getElementsByTagName("a")).find((a) => a.getAttribute("rel") === "self");
    const uri = self?.getAttribute("href");
    if (uri) out.push({ uri, values });
  }
  return out;
}

async function stopAll(): Promise<void> {
  running = false;
  if (tcpTimer) clearInterval(tcpTimer);
  if (retryTimer) clearTimeout(retryTimer);
  tcpTimer = undefined;
  retryTimer = undefined;
  const s = sub;
  sub = undefined;
  await s?.stop();
}

async function connect(cfg: ScopeConfig): Promise<void> {
  if (!running || !client) return;
  const prev = sub;
  sub = undefined;
  await prev?.stop(); // delete the old subscription first
  const s = new RwsSubscriptionClient({
    client,
    resources: cfg.resources,
    parseEvents: parseWithDom,
    // Verified (Chrome 157): the RWS session cookies (no SameSite attribute, so Lax)
    // are not sent on a WebSocket handshake from an extension page, and DNR header
    // rules are not applied to it either; the controller answers 401 and the
    // client falls back to fast polling (pollIntervalMs) automatically.
    pollIntervalMs: 250,
    onEvent: (e) => emit({ kind: "event", uri: e.uri, values: e.values, source: e.source }),
    onModeChange: (mode, reason) => {
      emit({ kind: "mode", mode, reason });
      if (mode === "polling" && running && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          backoffMs = Math.min(backoffMs * 2, 30_000);
          void connect(cfg);
        }, backoffMs);
      }
      if (mode === "websocket") backoffMs = 1000;
    },
  });
  sub = s;
  try {
    await s.start();
  } catch (e) {
    emit({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
}

async function start(cfg: ScopeConfig): Promise<void> {
  await stopAll();
  running = true;
  backoffMs = 1000;
  client = new RwsReadOnlyClient({ baseUrl: cfg.baseUrl, username: cfg.username, password: cfg.password, task: cfg.task, dialect: cfg.dialect, timeoutMs: 5000 });
  if (cfg.resources.length > 0) await connect(cfg);
  if (cfg.tcpPollMs > 0) {
    tcpTimer = setInterval(() => {
      void client
        ?.getTcp()
        .then((t) => emit({ kind: "tcp", x: t.x, y: t.y, z: t.z }))
        .catch((e: unknown) => emit({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
    }, Math.max(50, cfg.tcpPollMs));
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const m = message as { target?: string; command?: string; config?: ScopeConfig } | null;
  if (!m || m.target !== "offscreen" || sender.id !== chrome.runtime.id) return false;
  if (m.command === "start" && m.config) void start(m.config);
  if (m.command === "stop") void stopAll();
  sendResponse({ ack: true }); // lets the service worker know the listener is up
  return false;
});
