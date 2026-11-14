import { RwsError, RwsReadOnlyClient } from "mcp-robotstudio/rws";
import {
  buildBaseUrl,
  buildOriginPattern,
  ensureTrustedSessionAccess,
  type ExtensionRequest,
  type ExtensionResponse,
  isLoopbackHost,
  loadSessionPassword,
  loadSettings,
  SessionCookieStore,
} from "./storage.js";

const cookieStore = new SessionCookieStore();

void ensureTrustedSessionAccess();

chrome.runtime?.onInstalled?.addListener(() => {
  void ensureTrustedSessionAccess();
  if (chrome.sidePanel?.setPanelBehavior) {
    void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  }
});

async function createReadOnlyClient(): Promise<{
  client: RwsReadOnlyClient;
  baseUrl: string;
  isLoopback: boolean;
}> {
  const settings = await loadSettings();
  const baseUrl = buildBaseUrl(settings);
  const loopback = isLoopbackHost(settings.host);

  if (!loopback && chrome.permissions?.contains) {
    const origin = buildOriginPattern(settings.host);
    const granted = await chrome.permissions.contains({ origins: [origin] });
    if (!granted) {
      throw new Error(
        `Falta permiso de origen para ${origin}. Abra Opciones y guarde la configuracion para conceder acceso al controlador remoto.`,
      );
    }
  }

  const password = await loadSessionPassword();
  const client = new RwsReadOnlyClient({
    baseUrl,
    username: settings.username,
    password,
    task: settings.task,
    timeoutMs: 8_000,
    cookieStore,
  });

  return { client, baseUrl, isLoopback: loopback };
}

function toErrorResponse(err: unknown): ExtensionResponse {
  if (err instanceof RwsError) {
    return {
      ok: false,
      error: err.rwsMessage || err.message,
      code: err.rwsCode,
      status: err.status,
    };
  }
  return {
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  };
}

async function handleReadOnlyRequest(req: ExtensionRequest): Promise<ExtensionResponse> {
  const { client, baseUrl, isLoopback } = await createReadOnlyClient();

  switch (req.action) {
    case "getDashboardData": {
      const controller = await client.getControllerState();
      const [modules, signals, elog, joints, tcp] = await Promise.all([
        client.listModules(controller.task),
        client.listSignals(req.signalFilter ?? "", 100),
        client.getEventLog(12, 0),
        client.getJoints().catch(() => undefined),
        client.getTcp().catch(() => undefined),
      ]);
      return {
        ok: true,
        data: {
          baseUrl,
          isLoopback,
          controller,
          modules,
          signals: { signals: signals.signals, filter: signals.filter },
          events: elog.events,
          joints,
          tcp,
        },
      };
    }

    case "getSignals": {
      const res = await client.listSignals(req.filter ?? "", req.limit ?? 100);
      return { ok: true, signals: res.signals, filter: res.filter };
    }

    case "readSymbol": {
      const mod = req.module.trim();
      const sym = req.symbol.trim();
      if (!mod || !sym) {
        return { ok: false, error: "Debe indicar modulo y nombre de simbolo." };
      }
      const res = await client.readRapidSymbol(mod, sym, req.task);
      return {
        ok: true,
        symbolResult: {
          task: res.task,
          module: res.module,
          symbol: res.symbol,
          value: res.value,
        },
      };
    }

    case "checkConnection": {
      const [system, panel] = await Promise.all([
        client.getSystemInfo(),
        client.getPanelState(),
      ]);
      return {
        ok: true,
        connection: {
          baseUrl,
          system,
          ctrlstate: panel.ctrlstate,
        },
      };
    }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Reject messages from outside this extension or untrusted extension origins
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "Untrusted sender rejected" } satisfies ExtensionResponse);
    return false;
  }
  const ownOrigin = chrome.runtime.getURL("");
  if (sender.url && !sender.url.startsWith(ownOrigin)) {
    sendResponse({ ok: false, error: "Untrusted sender URL rejected" } satisfies ExtensionResponse);
    return false;
  }

  const req = message as ExtensionRequest | null;
  if (!req || typeof req !== "object" || typeof req.action !== "string") {
    sendResponse({ ok: false, error: "Invalid request payload" } satisfies ExtensionResponse);
    return false;
  }

  void handleReadOnlyRequest(req)
    .then((resp) => sendResponse(resp))
    .catch((err) => sendResponse(toErrorResponse(err)));

  return true;
});
