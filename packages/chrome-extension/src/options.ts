import {
  buildOriginPattern,
  DEFAULT_SETTINGS,
  type ExtensionRequest,
  type ExtensionResponse,
  isLoopbackHost,
  loadSessionPassword,
  loadSettings,
  sanitizeHost,
  saveSessionPassword,
  saveSettings,
  validatePort,
} from "./storage.js";

const form = document.getElementById("options-form") as HTMLFormElement;
const hostInput = document.getElementById("opt-host") as HTMLInputElement;
const portInput = document.getElementById("opt-port") as HTMLInputElement;
const taskInput = document.getElementById("opt-task") as HTMLInputElement;
const userInput = document.getElementById("opt-user") as HTMLInputElement;
const passInput = document.getElementById("opt-pass") as HTMLInputElement;
const remoteWarning = document.getElementById("remote-http-warning") as HTMLDivElement;
const statusBanner = document.getElementById("status-banner") as HTMLDivElement;
const testBtn = document.getElementById("test-btn") as HTMLButtonElement;

function updateRemoteWarning(): void {
  const host = hostInput.value.trim() || DEFAULT_SETTINGS.host;
  if (isLoopbackHost(host)) {
    remoteWarning.classList.add("hidden");
  } else {
    remoteWarning.classList.remove("hidden");
  }
}

function showStatus(kind: "ok" | "warn" | "err", message: string): void {
  statusBanner.className = `banner banner-${kind}`;
  statusBanner.textContent = message;
}

async function ensureHostPermission(host: string): Promise<boolean> {
  if (isLoopbackHost(host)) return true;
  if (!chrome.permissions?.request) return true;
  const origin = buildOriginPattern(host);
  const already = chrome.permissions.contains
    ? await chrome.permissions.contains({ origins: [origin] })
    : false;
  if (already) return true;
  return await chrome.permissions.request({ origins: [origin] });
}

async function persistForm(): Promise<void> {
  const host = sanitizeHost(hostInput.value);
  const port = validatePort(Number(portInput.value));
  const task = taskInput.value.trim() || DEFAULT_SETTINGS.task;
  const username = userInput.value.trim() || DEFAULT_SETTINGS.username;

  const granted = await ensureHostPermission(host);
  if (!granted) {
    showStatus(
      "warn",
      `Permiso rechazado para http://${host}/*. Conceda acceso al origen o use loopback (127.0.0.1).`,
    );
    return;
  }

  await saveSettings({ host, port, task, username });
  await saveSessionPassword(passInput.value);
  showStatus("ok", `Configuracion guardada para http://${host}:${port} (contrasena solo en sesion).`);
}

async function testConnection(): Promise<void> {
  testBtn.disabled = true;
  try {
    await persistForm();
    const resp = (await chrome.runtime.sendMessage({
      action: "checkConnection",
    } satisfies ExtensionRequest)) as ExtensionResponse;

    if (!resp.ok || !("connection" in resp)) {
      showStatus("err", resp.ok ? "Error inesperado" : `Error RWS: ${resp.error}`);
      return;
    }

    const { baseUrl, system, ctrlstate } = resp.connection;
    showStatus(
      "ok",
      `Conexion verificada con ${baseUrl}: ${system.name ?? "Robot"} (RW ${system.rwversion ?? "?"}), motores=${ctrlstate ?? "?"}`,
    );
  } catch (err) {
    showStatus("err", err instanceof Error ? err.message : String(err));
  } finally {
    testBtn.disabled = false;
  }
}

async function init(): Promise<void> {
  const [settings, password] = await Promise.all([loadSettings(), loadSessionPassword()]);
  hostInput.value = settings.host;
  portInput.value = String(settings.port);
  taskInput.value = settings.task;
  userInput.value = settings.username;
  passInput.value = password;
  updateRemoteWarning();
}

hostInput.addEventListener("input", updateRemoteWarning);

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  void persistForm().catch((err) => {
    showStatus("err", err instanceof Error ? err.message : String(err));
  });
});

testBtn.addEventListener("click", () => {
  void testConnection();
});

void init();
