import {
  buildOriginPattern,
  DEFAULT_SETTINGS,
  type ExtensionDialect,
  type ExtensionRequest,
  type ExtensionResponse,
  type FleetEntry,
  isLoopbackHost,
  loadSessionPassword,
  loadSettings,
  sanitizeFleet,
  sanitizeHost,
  saveSessionPassword,
  saveSettings,
  validatePort,
} from "./storage.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("options-form");
const hostInput = $<HTMLInputElement>("opt-host");
const portInput = $<HTMLInputElement>("opt-port");
const taskInput = $<HTMLInputElement>("opt-task");
const userInput = $<HTMLInputElement>("opt-user");
const passInput = $<HTMLInputElement>("opt-pass");
const dialectInput = $<HTMLSelectElement>("opt-dialect");
const fleetInput = $<HTMLTextAreaElement>("opt-fleet");
const writeInput = $<HTMLInputElement>("opt-write");
const remoteWarning = $<HTMLDivElement>("remote-http-warning");
const statusBanner = $<HTMLDivElement>("status-banner");
const testBtn = $<HTMLButtonElement>("test-btn");

const send = async (req: ExtensionRequest) => (await chrome.runtime.sendMessage(req)) as ExtensionResponse;

function updateRemoteWarning(): void {
  const host = hostInput.value.trim() || DEFAULT_SETTINGS.host;
  remoteWarning.classList.toggle("hidden", isLoopbackHost(host) || dialectInput.value === "rws2");
}

function showStatus(kind: "ok" | "warn" | "err", message: string): void {
  statusBanner.className = `banner banner-${kind}`;
  statusBanner.textContent = message;
}

function parseFleet(text: string): FleetEntry[] {
  return sanitizeFleet(
    text
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 3)
      .map(([name, host, port, dialect]) => ({ name, host, port: Number(port), dialect })),
  );
}

async function ensureHostPermission(host: string, dialect: ExtensionDialect): Promise<boolean> {
  if (isLoopbackHost(host) && dialect === "rws1") return true;
  if (!chrome.permissions?.request) return true;
  const origin = buildOriginPattern(host, dialect);
  if (chrome.permissions.contains && (await chrome.permissions.contains({ origins: [origin] }))) return true;
  return await chrome.permissions.request({ origins: [origin] });
}

async function persistForm(): Promise<boolean> {
  const host = sanitizeHost(hostInput.value);
  const port = validatePort(Number(portInput.value));
  const dialect: ExtensionDialect = dialectInput.value === "rws2" ? "rws2" : "rws1";
  const fleet = parseFleet(fleetInput.value);
  for (const target of [{ host, dialect }, ...fleet]) {
    if (!(await ensureHostPermission(target.host, target.dialect))) {
      showStatus("warn", `Permiso rechazado para ${buildOriginPattern(target.host, target.dialect)}.`);
      return false;
    }
  }
  await saveSettings({ host, port, task: taskInput.value.trim() || DEFAULT_SETTINGS.task, username: userInput.value.trim() || DEFAULT_SETTINGS.username, dialect, fleet });
  await saveSessionPassword(passInput.value);
  showStatus("ok", `Configuracion guardada para ${dialect === "rws2" ? "https" : "http"}://${host}:${port} (contrasena solo en sesion, ${fleet.length} celdas extra).`);
  return true;
}

async function testConnection(): Promise<void> {
  testBtn.disabled = true;
  try {
    if (!(await persistForm())) return;
    const resp = await send({ action: "checkConnection" });
    if (!resp.ok || !("connection" in resp)) {
      showStatus("err", resp.ok ? "Error inesperado" : `Error RWS: ${resp.error}`);
      return;
    }
    const { baseUrl, system, ctrlstate } = resp.connection;
    showStatus("ok", `Conexion verificada con ${baseUrl}: ${system.name ?? "Robot"} (RW ${system.rwversion ?? "?"}), motores=${ctrlstate ?? "?"}`);
  } catch (err) {
    showStatus("err", err instanceof Error ? err.message : String(err));
  } finally {
    testBtn.disabled = false;
  }
}

async function refreshLicense(): Promise<void> {
  const r = await send({ action: "getLicense" });
  const info = $<HTMLDivElement>("license-info");
  if (r.ok && "result" in r) {
    const l = r.result as { plan: string; subject?: string; expiresAt?: string; reason?: string };
    info.textContent = l.plan === "pro" ? `PRO activa: ${l.subject ?? "-"} hasta ${l.expiresAt?.slice(0, 10) ?? "-"}` : `Plan gratuito${l.reason ? ` (${l.reason})` : ""}.`;
  }
  const w = await send({ action: "getWriteMode" });
  if (w.ok && "result" in w) writeInput.checked = (w.result as { enabled: boolean }).enabled;
}

async function init(): Promise<void> {
  const [settings, password] = await Promise.all([loadSettings(), loadSessionPassword()]);
  hostInput.value = settings.host;
  portInput.value = String(settings.port);
  taskInput.value = settings.task;
  userInput.value = settings.username;
  passInput.value = password;
  dialectInput.value = settings.dialect ?? "rws1";
  fleetInput.value = (settings.fleet ?? []).map((f) => `${f.name} ${f.host} ${f.port} ${f.dialect}`).join("\n");
  updateRemoteWarning();
  await refreshLicense();
}

hostInput.addEventListener("input", updateRemoteWarning);
dialectInput.addEventListener("change", updateRemoteWarning);
form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  void persistForm().catch((err) => showStatus("err", err instanceof Error ? err.message : String(err)));
});
testBtn.addEventListener("click", () => void testConnection());
writeInput.addEventListener("change", () => {
  void send({ action: "setWriteMode", enabled: writeInput.checked }).then(() => showStatus(writeInput.checked ? "warn" : "ok", writeInput.checked ? "Modo escritura ACTIVO hasta cerrar el navegador." : "Modo escritura desactivado."));
});
$<HTMLButtonElement>("license-btn").addEventListener("click", () => {
  void send({ action: "activateLicense", token: $<HTMLInputElement>("opt-license").value }).then(async (r) => {
    const st = r.ok && "result" in r ? (r.result as { plan: string; reason?: string }) : null;
    showStatus(st?.plan === "pro" ? "ok" : "err", st?.plan === "pro" ? "Licencia PRO activada." : `Licencia no valida: ${st?.reason ?? (r.ok ? "" : r.error)}`);
    await refreshLicense();
  });
});
$<HTMLButtonElement>("license-off-btn").addEventListener("click", () => void send({ action: "deactivateLicense" }).then(refreshLicense));

void init();
