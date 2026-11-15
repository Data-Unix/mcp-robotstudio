import type { RwsReadOnlyClient } from "./client.js";
import { type SubscriptionPriority, validateSubscriptionPriority } from "./dialect.js";
import { RwsError } from "./digest.js";
import { decodeXmlEntities } from "./parsers.js";

/**
 * RWS subscriptions: POST /subscription (resources=N&N=<uri>&N-p=<prio>), then a
 * WebSocket on the returned Location with subprotocol robapi2_subscription
 * (RWS 1.0) or rws_subscription (RWS 2.0). Falls back to polling the resources
 * when the POST or the WebSocket upgrade is refused (proxy, controller limit).
 */
export interface SubscriptionResource {
  uri: string;
  priority: SubscriptionPriority;
}

export interface SubscriptionEvent {
  uri: string;
  values: Record<string, string>;
  receivedAt: number;
  source: "websocket" | "polling";
}

export type SubscriptionMode = "websocket" | "polling" | "closed";

/** Minimal surface shared by the browser and Node (undici) WebSocket. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  close(code?: number, reason?: string): void;
  readonly protocol?: string;
}

export type WebSocketFactory = (url: string, protocol: string, cookieHeader: string) => WebSocketLike;

export interface RwsSubscriptionOptions {
  client: RwsReadOnlyClient;
  resources: SubscriptionResource[];
  onEvent: (event: SubscriptionEvent) => void;
  onModeChange?: (mode: SubscriptionMode, reason?: string) => void;
  webSocketFactory?: WebSocketFactory;
  pollIntervalMs?: number;
  /** Check that priority-2 RAPID symbols really are PERS (default true). */
  verifyPers?: boolean;
  /** Milliseconds to wait for the WebSocket to open before falling back. */
  openTimeoutMs?: number;
  /** Event document parser (default: regex; browsers may pass a DOMParser-based one). */
  parseEvents?: (xml: string) => Array<{ uri: string; values: Record<string, string> }>;
}

export function buildSubscriptionBody(resources: SubscriptionResource[]): string {
  const parts: string[] = [];
  resources.forEach((r, i) => {
    const n = String(i + 1);
    parts.push(`resources=${n}`, `${n}=${encodeURIComponent(r.uri)}`, `${n}-p=${r.priority}`);
  });
  return parts.join("&");
}

/** Parses an RWS event document (XHTML; events are not available as JSON). */
/**
 * Parses an RWS event document. Verified live on RW 6.16: a RAPID symbol event
 * is `<li class="rap-value-ev">` (self link only) followed by a sibling
 * `<li class="rap-data"><span class="value">..</span></li>`, so spans of the
 * non-event <li> that follow an event are merged into it.
 */
export function parseSubscriptionEvents(xml: string): Array<{ uri: string; values: Record<string, string> }> {
  const out: Array<{ uri: string; values: Record<string, string> }> = [];
  const blocks = xml.match(/<li\s+class="[^"]*"[\s\S]*?<\/li>/gi) ?? [];
  for (const block of blocks) {
    const isEvent = /^<li\s+class="[^"]*-ev"/i.test(block);
    if (isEvent) {
      const uri = /<a\s+href="([^"]+)"\s+rel="self"/i.exec(block)?.[1];
      if (uri) out.push({ uri: decodeXmlEntities(uri), values: spanMap(block) });
      continue;
    }
    const last = out[out.length - 1];
    if (last) for (const [k, v] of Object.entries(spanMap(block))) if (!(k in last.values)) last.values[k] = v;
  }
  return out;
}

function spanMap(xml: string): Record<string, string> {
  const values: Record<string, string> = {};
  const re = /<span\s+class="([^"]+)"[^>]*>([^<]*)</gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const key = m[1];
    if (key && !(key in values)) values[key] = decodeXmlEntities((m[2] ?? "").trim());
  }
  return values;
}

function defaultWebSocketFactory(url: string, protocol: string, cookieHeader: string): WebSocketLike {
  const WS = (globalThis as unknown as { WebSocket?: new (u: string, p?: unknown) => WebSocketLike }).WebSocket;
  if (!WS) throw new Error("WebSocket is not available in this runtime");
  const isNode = typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string";
  // Node's undici WebSocket accepts { protocols, headers }. Browsers only take the
  // protocol list; from an extension page Chrome does not attach the (Lax) RWS
  // session cookies, so the controller answers 401 and start() falls back to polling.
  return isNode && cookieHeader
    ? new WS(url, { protocols: [protocol], headers: { Cookie: cookieHeader } })
    : new WS(url, protocol);
}

export class RwsSubscriptionClient {
  private readonly opts: Required<Omit<RwsSubscriptionOptions, "onModeChange">> &
    Pick<RwsSubscriptionOptions, "onModeChange">;
  private ws?: WebSocketLike;
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastPolled = new Map<string, string>();
  private subscriptionPath?: string;
  private currentMode: SubscriptionMode = "closed";

  constructor(options: RwsSubscriptionOptions) {
    this.opts = {
      webSocketFactory: defaultWebSocketFactory,
      pollIntervalMs: 250,
      verifyPers: true,
      openTimeoutMs: 3000,
      parseEvents: parseSubscriptionEvents,
      ...options,
    };
  }

  get mode(): SubscriptionMode {
    return this.currentMode;
  }

  /** Validates priorities against the ABB rules, including the PERS check. */
  async validate(): Promise<void> {
    if (this.opts.resources.length === 0) {
      throw new RwsError("At least one subscription resource is required", {
        status: 400,
        rwsCode: "NO_RESOURCES",
      });
    }
    for (const r of this.opts.resources) {
      const err = validateSubscriptionPriority(r.uri, r.priority);
      if (err) throw new RwsError(err, { status: 400, rwsCode: "INVALID_PRIORITY", rwsMessage: err });
      const sym = /^\/rw\/rapid\/symbol\/(?:data\/RAPID|RAPID)\/([^/]+)\/([^/]+)\/([^/;]+)/.exec(r.uri);
      if (r.priority === 2 && sym && this.opts.verifyPers) {
        const props = await this.opts.client.getSymbolProperties(sym[2]!, sym[3]!, sym[1]!);
        if (props.symtyp !== "per") {
          const msg = `priority 2 needs a PERS symbol; ${sym[2]}/${sym[3]} is ${props.symtyp ?? "unknown"}`;
          throw new RwsError(msg, { status: 400, rwsCode: "INVALID_PRIORITY", rwsMessage: msg });
        }
      }
    }
  }

  async start(): Promise<{ mode: SubscriptionMode; location?: string; reason?: string }> {
    await this.validate();
    let location: string | undefined;
    try {
      const res = await this.opts.client.request("POST", "/subscription", {
        body: buildSubscriptionBody(this.opts.resources),
        contentType: this.opts.client.routes.formContentType,
      });
      location = res.location ?? /href="(wss?:\/\/[^"]+)"/i.exec(res.body)?.[1];
      if (!location) throw new Error("subscription created without a WebSocket location");
      // RW6 returns the current values in the 201 body (verified live): emit them as the snapshot.
      for (const e of this.opts.parseEvents(res.body)) {
        this.opts.onEvent({ ...e, receivedAt: Date.now(), source: "websocket" });
      }
      this.subscriptionPath = /\/poll\/(\d+)/.exec(location)?.[1];
      await this.openWebSocket(location);
      this.setMode("websocket");
      return { mode: "websocket", location };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.startPolling(reason);
      return { mode: "polling", ...(location ? { location } : {}), reason };
    }
  }

  private openWebSocket(location: string): Promise<void> {
    const wsUrl = location.replace(/^http/i, "ws");
    const protocol = this.opts.client.routes.subscriptionProtocol;
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = this.opts.webSocketFactory(wsUrl, protocol, this.opts.client.currentCookieHeader);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!opened) {
          ws.close();
          reject(new Error(`WebSocket did not open within ${this.opts.openTimeoutMs} ms`));
        }
      }, this.opts.openTimeoutMs);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        if (!opened) {
          clearTimeout(timer);
          reject(new Error("WebSocket upgrade refused"));
        }
      };
      ws.onmessage = (ev) => {
        const text = typeof ev.data === "string" ? ev.data : String(ev.data);
        for (const e of this.opts.parseEvents(text)) {
          this.opts.onEvent({ ...e, receivedAt: Date.now(), source: "websocket" });
        }
      };
      ws.onclose = (ev) => {
        if (opened && this.currentMode === "websocket") {
          this.startPolling(`WebSocket closed (${ev.code ?? "?"} ${ev.reason ?? ""})`.trim());
        }
      };
    });
  }

  private startPolling(reason: string): void {
    if (this.pollTimer) return;
    this.setMode("polling", reason);
    const tick = async () => {
      for (const r of this.opts.resources) {
        const path = r.uri.split(";")[0]!;
        try {
          const { body } = await this.opts.client.request("GET", path);
          const values = spanMap(body);
          const sig = JSON.stringify(values);
          if (this.lastPolled.get(r.uri) !== sig) {
            this.lastPolled.set(r.uri, sig);
            this.opts.onEvent({ uri: r.uri, values, receivedAt: Date.now(), source: "polling" });
          }
        } catch {
          // keep polling the other resources
        }
      }
    };
    void tick();
    this.pollTimer = setInterval(() => void tick(), this.opts.pollIntervalMs);
  }

  private setMode(mode: SubscriptionMode, reason?: string): void {
    this.currentMode = mode;
    this.opts.onModeChange?.(mode, reason);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    const ws = this.ws;
    this.ws = undefined;
    this.setMode("closed");
    ws?.close();
    if (this.subscriptionPath) {
      await this.opts.client.request("DELETE", `/subscription/${this.subscriptionPath}`).catch(() => undefined);
    }
  }
}
