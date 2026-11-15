import { captureForensicBlackbox } from "mcp-robotstudio/forensics";
import { checkJoints, distance, isUnitQuat, orientationErrorDeg, parsePoseLiteral, type Joints } from "mcp-robotstudio/kinematics";
import { validateRapidModule } from "mcp-robotstudio/rapid/validator";
import { checkRecipeWrite } from "mcp-robotstudio/recipes";
import { RwsClient, RwsError, RwsReadOnlyClient } from "mcp-robotstudio/rws";
import { isPro, licenseProvider } from "./license.js";
import {
  buildBaseUrl,
  buildOriginPattern,
  ensureTrustedSessionAccess,
  type ExtensionRequest,
  type ExtensionResponse,
  isLoopbackHost,
  loadSessionPassword,
  loadSettings,
  loadWriteMode,
  PRO_READ_ACTIONS,
  PRO_WRITE_ACTIONS,
  type RwsExtensionSettings,
  saveWriteMode,
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

async function assertOrigin(settings: Pick<RwsExtensionSettings, "host" | "dialect">): Promise<void> {
  if (isLoopbackHost(settings.host) || !chrome.permissions?.contains) return;
  const origin = buildOriginPattern(settings.host, settings.dialect);
  if (!(await chrome.permissions.contains({ origins: [origin] }))) {
    throw new Error(`Falta permiso de origen para ${origin}. Abra Opciones y guarde la configuracion para conceder acceso.`);
  }
}

async function createClient<T extends typeof RwsReadOnlyClient>(
  Cls: T,
  override?: Pick<RwsExtensionSettings, "host" | "port" | "dialect">,
): Promise<{ client: InstanceType<T>; baseUrl: string; isLoopback: boolean; settings: RwsExtensionSettings }> {
  const settings = await loadSettings();
  const target = { ...settings, ...(override ?? {}) };
  const baseUrl = buildBaseUrl(target);
  await assertOrigin(target);
  const password = await loadSessionPassword();
  const client = new Cls({
    baseUrl,
    username: settings.username,
    password,
    task: settings.task,
    timeoutMs: 8_000,
    cookieStore,
    dialect: target.dialect ?? "rws1",
  }) as InstanceType<T>;
  return { client, baseUrl, isLoopback: isLoopbackHost(target.host), settings };
}

function toErrorResponse(err: unknown): ExtensionResponse {
  if (err instanceof RwsError) return { ok: false, error: err.rwsMessage || err.message, code: err.rwsCode, status: err.status };
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

const ok = (result: unknown): ExtensionResponse => ({ ok: true, result });

// --------------------------------------------------------------------------
// Offscreen document: keeps the RWS WebSocket subscription alive beyond the
// service worker lifetime; it parses the XHTML event documents with DOMParser.
// --------------------------------------------------------------------------
async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: "Keep one RWS WebSocket subscription open and parse its XHTML event documents for the oscilloscope.",
  });
}

async function handleFree(req: ExtensionRequest): Promise<ExtensionResponse | null> {
  switch (req.action) {
    case "getLicense":
      return ok({ ...(await licenseProvider.getStatus()), checkoutUrl: licenseProvider.checkoutUrl() });
    case "activateLicense":
      return ok(await licenseProvider.activate(req.token));
    case "deactivateLicense":
      await licenseProvider.deactivate();
      return ok({ plan: "free" });
    case "getWriteMode":
      return ok({ enabled: await loadWriteMode() });
    case "setWriteMode":
      await saveWriteMode(req.enabled === true);
      return ok({ enabled: await loadWriteMode() });
    default:
      break;
  }

  const { client, baseUrl, isLoopback } = await createClient(RwsReadOnlyClient);
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
        data: { baseUrl, isLoopback, controller, modules, signals: { signals: signals.signals, filter: signals.filter }, events: elog.events, joints, tcp },
      };
    }
    case "getSignals": {
      const res = await client.listSignals(req.filter ?? "", req.limit ?? 100);
      return { ok: true, signals: res.signals, filter: res.filter };
    }
    case "readSymbol": {
      const mod = req.module.trim();
      const sym = req.symbol.trim();
      if (!mod || !sym) return { ok: false, error: "Debe indicar modulo y nombre de simbolo." };
      const res = await client.readRapidSymbol(mod, sym, req.task);
      return { ok: true, symbolResult: { task: res.task, module: res.module, symbol: res.symbol, value: res.value } };
    }
    case "checkConnection": {
      const [system, panel] = await Promise.all([client.getSystemInfo(), client.getPanelState()]);
      return { ok: true, connection: { baseUrl, system, ctrlstate: panel.ctrlstate } };
    }
    default:
      return null;
  }
}

function parseDecls(source: string, type: string): Array<{ name: string; value: string }> {
  const re = new RegExp(`^\\s*(?:TASK\\s+)?PERS\\s+${type}\\s+(\\w+)\\s*:=\\s*(.+);`, "gim");
  return [...source.matchAll(re)].map((m) => ({ name: m[1]!, value: m[2]!.trim() }));
}

async function handlePro(req: ExtensionRequest): Promise<ExtensionResponse | null> {
  const { client, baseUrl, settings } = await createClient(RwsClient);
  switch (req.action) {
    case "getTelemetryPro": {
      const tool = req.tool ?? "tool0";
      const wobj = req.wobj ?? "wobj0";
      const [panel, speed, pcp, joints, tcp, mech] = await Promise.all([
        client.getPanelState(),
        client.getSpeedRatio(),
        client.getProgramPointer().catch(() => null),
        client.getJoints(),
        client.getTcp(tool, wobj).catch(() => null),
        client.getMechunitStatus().catch(() => null),
      ]);
      const j = joints.jointsDeg.length === 6 ? (joints.jointsDeg as Joints) : null;
      const safety = j ? checkJoints(j) : null;
      const sr = speed.speedRatio;
      return ok({
        baseUrl,
        dialect: client.dialect,
        panel,
        speedRatio: sr,
        speedAlert: panel.opmode === "AUTO" && sr !== null && sr < 100,
        cycleTimeFactor: sr ? 100 / sr : null,
        pcp,
        joints: joints.jointsDeg,
        tcp,
        mechunit: mech,
        safety,
      });
    }
    case "captureForensic":
      return ok(await captureForensicBlackbox(client, { contextLines: req.contextLines ?? 5 }));
    case "readModuleSource":
      return ok(await client.readModuleSource(req.module));
    case "getFleet": {
      const cells = [{ name: "principal", host: settings.host, port: settings.port, dialect: settings.dialect ?? "rws1" }, ...(settings.fleet ?? [])];
      const rows = await Promise.all(
        cells.map(async (cell) => {
          try {
            const { client: c, baseUrl: url } = await createClient(RwsReadOnlyClient, cell);
            const [sys, panel, speed, mech] = await Promise.all([c.getSystemInfo(), c.getPanelState(), c.getSpeedRatio(), c.getMechunitStatus().catch(() => null)]);
            return { cell: cell.name, baseUrl: url, dialect: c.dialect, system: sys.name, rw: sys.rwversion, ctrlstate: panel.ctrlstate, opmode: panel.opmode, exec: panel.ctrlexecstate, speedRatio: speed.speedRatio, smbSync: mech?.status ?? null };
          } catch (e) {
            return { cell: cell.name, baseUrl: `${cell.host}:${cell.port}`, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      return ok({ rows });
    }
    case "getStorePathCert": {
      const [stop, back] = await Promise.all([
        client.readRapidSymbol(req.module, req.stopSymbol),
        client.readRapidSymbol(req.module, req.returnSymbol),
      ]);
      const a = parsePoseLiteral(stop.value ?? "");
      const b = parsePoseLiteral(back.value ?? "");
      const errMm = distance(a.trans, b.trans);
      const errDeg = isUnitQuat(a.rot) && isUnitQuat(b.rot) ? orientationErrorDeg(a.rot, b.rot) : null;
      return ok({ stop: stop.value, back: back.value, errorMm: errMm, errorDeg: errDeg, at: new Date().toISOString() });
    }
    case "getLiveAudit": {
      const [signals, modules] = await Promise.all([client.listSignals("", 200), client.listModules()]);
      const calib = modules.modules.find((m) => m.toLowerCase() === "calibdata");
      const src = calib ? (await client.readModuleSource(calib)).source : "";
      return ok({ signals: signals.signals, modules: modules.items, tools: parseDecls(src, "tooldata"), wobjs: parseDecls(src, "wobjdata") });
    }
    case "startScope": {
      await ensureOffscreen();
      const password = await loadSessionPassword();
      const msg = {
        target: "offscreen",
        command: "start",
        config: { baseUrl, username: settings.username, password, task: settings.task, dialect: settings.dialect ?? "rws1", resources: req.resources, tcpPollMs: req.tcpPollMs ?? 200 },
      };
      // A freshly created offscreen document may not have its listener yet: retry until it acks.
      for (let i = 0; i < 30; i++) {
        const r = (await chrome.runtime.sendMessage(msg).catch(() => undefined)) as { ack?: boolean } | undefined;
        if (r?.ack) return ok({ started: true });
        await new Promise((res) => setTimeout(res, 100));
      }
      return { ok: false, error: "El documento offscreen no responde." };
    }
    case "stopScope": {
      const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
      if (contexts.length > 0) {
        await chrome.runtime.sendMessage({ target: "offscreen", command: "stop" }).catch(() => undefined);
        await chrome.offscreen.closeDocument().catch(() => undefined);
      }
      return ok({ stopped: true });
    }
    // ---- writes (also gated by the session write mode) ----
    case "setSpeedRatio":
      return ok(await client.setSpeedRatio(req.ratio));
    case "writeRecipe": {
      const props = await client.getSymbolProperties(req.module, req.symbol);
      if (props.symtyp !== "per") return { ok: false, error: `${req.module}/${req.symbol} es ${props.symtyp ?? "desconocido"}: solo se escriben PERS.` };
      const current = (await client.readRapidSymbol(req.module, req.symbol)).value;
      const tool = req.tool ? parsePoseLiteral(req.tool.replace(/^\s*\[\s*(TRUE|FALSE)\s*,/i, "[")) : undefined;
      const shield = checkRecipeWrite(props.dattyp, current, req.value, { deltaMaxMm: req.deltaMaxMm, tool });
      if (!shield.allowed) return ok({ written: false, shield });
      const res = await client.writeRapidSymbol(req.module, req.symbol, req.value);
      return ok({ written: res.success, previous: current, shield });
    }
    case "loadModuleSafe": {
      const offline = validateRapidModule(req.content);
      if (!offline.ok) return ok({ loaded: false, stage: "offline-validation", offline });
      const res = await client.loadModule({ fileName: req.fileName, content: req.content });
      return ok({ loaded: res.success, stage: "controller", offline, controller: res });
    }
    case "triggerBackup":
      return ok(await client.triggerBackup(req.dirName, 30_000));
    default:
      return null;
  }
}

export async function handleRequest(req: ExtensionRequest): Promise<ExtensionResponse> {
  if (PRO_READ_ACTIONS.has(req.action) || PRO_WRITE_ACTIONS.has(req.action)) {
    if (!(await isPro())) return { ok: false, error: "Funcion PRO: active la suscripcion MCP-ROBOTSTUDIO PRO.", proRequired: true };
    if (PRO_WRITE_ACTIONS.has(req.action) && !(await loadWriteMode())) {
      return { ok: false, error: "Escritura desactivada: active el modo escritura de esta sesion en Opciones.", writeModeRequired: true };
    }
    return (await handlePro(req)) ?? { ok: false, error: `Accion no soportada: ${req.action}` };
  }
  return (await handleFree(req)) ?? { ok: false, error: `Accion no soportada: ${req.action}` };
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Messages for the offscreen document or oscilloscope events are not ours.
  const m = message as { target?: string; channel?: string } | null;
  if (m && (m.target === "offscreen" || m.channel === "scope")) return false;

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
  void handleRequest(req)
    .then((resp) => sendResponse(resp))
    .catch((err) => sendResponse(toErrorResponse(err)));
  return true;
});
