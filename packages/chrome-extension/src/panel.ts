import type { EventLogEntry, IoSignalInfo } from "mcp-robotstudio/rws";
import type { DashboardPayload, ExtensionRequest, ExtensionResponse } from "./storage.js";

const connectionBadge = document.getElementById("connection-badge") as HTMLSpanElement;
const httpWarning = document.getElementById("http-warning") as HTMLDivElement;
const errorBanner = document.getElementById("error-banner") as HTMLDivElement;
const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;
const openSidepanelBtn = document.getElementById("open-sidepanel-btn") as HTMLButtonElement;

const controllerGrid = document.getElementById("controller-grid") as HTMLDivElement;
const motionGrid = document.getElementById("motion-grid") as HTMLDivElement;
const modulesCount = document.getElementById("modules-count") as HTMLSpanElement;
const modulesBody = document.getElementById("modules-body") as HTMLTableSectionElement;
const signalsCount = document.getElementById("signals-count") as HTMLSpanElement;
const signalsBody = document.getElementById("signals-body") as HTMLTableSectionElement;
const signalFilterInput = document.getElementById("signal-filter") as HTMLInputElement;
const signalFilterBtn = document.getElementById("signal-filter-btn") as HTMLButtonElement;
const eventsBody = document.getElementById("events-body") as HTMLTableSectionElement;

const symbolForm = document.getElementById("symbol-form") as HTMLFormElement;
const symbolModuleInput = document.getElementById("symbol-module") as HTMLInputElement;
const symbolNameInput = document.getElementById("symbol-name") as HTMLInputElement;
const symbolOutput = document.getElementById("symbol-output") as HTMLPreElement;

let cachedSignals: IoSignalInfo[] = [];

async function sendBgMessage<T extends ExtensionResponse>(req: ExtensionRequest): Promise<T> {
  return (await chrome.runtime.sendMessage(req)) as T;
}

function setConnectionStatus(kind: "ok" | "warn" | "err", text: string): void {
  connectionBadge.className = `badge badge-status-${kind}`;
  connectionBadge.textContent = text;
}

function showError(msg: string | null): void {
  if (!msg) {
    errorBanner.classList.add("hidden");
    errorBanner.textContent = "";
    return;
  }
  errorBanner.classList.remove("hidden");
  errorBanner.textContent = msg;
}

function createKvItem(label: string, value: string): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "kv-item";

  const lbl = document.createElement("span");
  lbl.className = "kv-label";
  lbl.textContent = label;

  const val = document.createElement("span");
  val.className = "kv-value";
  val.textContent = value;

  item.append(lbl, val);
  return item;
}

function createTextCell(value: string, mono = false): HTMLTableCellElement {
  const td = document.createElement("td");
  if (mono) td.className = "mono";
  td.textContent = value;
  return td;
}

function createEmptyRow(colSpan: number, text: string): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = colSpan;
  td.textContent = text;
  tr.appendChild(td);
  return tr;
}

function renderController(data: DashboardPayload): void {
  const { controller, joints, tcp } = data;
  const sys = controller.system;
  const panel = controller.panel;
  const primaryTask = controller.tasks[0];

  controllerGrid.replaceChildren(
    createKvItem("Controlador", `${sys.name ?? "—"} (RW ${sys.rwversion ?? "—"})`),
    createKvItem("Motores (ctrlstate)", panel.ctrlstate ?? "—"),
    createKvItem("Modo (opmode)", panel.opmode ?? "—"),
    createKvItem("Ejecucion RAPID", `${panel.ctrlexecstate ?? "—"} (${panel.cycle ?? "—"})`),
    createKvItem(
      "Tarea principal",
      primaryTask
        ? `${primaryTask.name} · ${primaryTask.excstate ?? "—"} · ${primaryTask.active ?? "—"}`
        : controller.task,
    ),
    createKvItem("Endpoint RWS", data.baseUrl),
  );

  const jointStr = joints?.jointsDeg?.length
    ? joints.jointsDeg.map((v, i) => `J${i + 1}:${v.toFixed(1)}`).join("  ")
    : "No disponible";
  const tcpStr =
    tcp && tcp.x !== null && tcp.y !== null && tcp.z !== null
      ? `X=${tcp.x.toFixed(1)}  Y=${tcp.y.toFixed(1)}  Z=${tcp.z.toFixed(1)} mm (${tcp.tool}/${tcp.wobj})`
      : "No disponible";

  motionGrid.replaceChildren(
    createKvItem("Ejes (deg)", jointStr),
    createKvItem("TCP", tcpStr),
  );
}

function renderModules(items: Array<{ name: string; type: string | null }>): void {
  modulesCount.textContent = String(items.length);
  if (items.length === 0) {
    modulesBody.replaceChildren(createEmptyRow(2, "Sin modulos cargados."));
    return;
  }
  const rows = items.map((m) => {
    const tr = document.createElement("tr");
    tr.append(createTextCell(m.name, true), createTextCell(m.type ?? "—"));
    return tr;
  });
  modulesBody.replaceChildren(...rows);
}

function renderSignals(signals: IoSignalInfo[], filterText: string): void {
  const q = filterText.trim().toLowerCase();
  const visible = q ? signals.filter((s) => s.name.toLowerCase().includes(q)) : signals;

  signalsCount.textContent = `${visible.length}/${signals.length}`;
  if (visible.length === 0) {
    signalsBody.replaceChildren(createEmptyRow(4, "No hay senales que coincidan con el filtro."));
    return;
  }
  const rows = visible.map((sig) => {
    const tr = document.createElement("tr");
    tr.append(
      createTextCell(sig.name, true),
      createTextCell(sig.type ?? "—"),
      createTextCell(sig.value ?? "—", true),
      createTextCell(sig.state ?? "—"),
    );
    return tr;
  });
  signalsBody.replaceChildren(...rows);
}

function renderEvents(events: EventLogEntry[]): void {
  if (events.length === 0) {
    eventsBody.replaceChildren(createEmptyRow(4, "Sin eventos recientes."));
    return;
  }
  const rows = events.map((ev) => {
    const tr = document.createElement("tr");
    tr.append(
      createTextCell(ev.code ?? "—", true),
      createTextCell(ev.title ?? ev.desc ?? "—"),
      createTextCell(ev.src ?? "—"),
      createTextCell(ev.time ?? "—", true),
    );
    return tr;
  });
  eventsBody.replaceChildren(...rows);
}

async function refreshDashboard(): Promise<void> {
  refreshBtn.disabled = true;
  setConnectionStatus("warn", "Consultando RWS…");
  showError(null);

  try {
    const resp = await sendBgMessage<ExtensionResponse>({ action: "getDashboardData" });
    if (!resp.ok || !("data" in resp)) {
      setConnectionStatus("err", "Sin conexion");
      showError(resp.ok ? "Respuesta inesperada." : resp.error);
      return;
    }

    const data = resp.data;
    if (data.isLoopback) {
      httpWarning.classList.add("hidden");
    } else {
      httpWarning.classList.remove("hidden");
    }

    setConnectionStatus("ok", `${data.controller.system.name ?? "Conectado"} ✓`);
    cachedSignals = data.signals.signals;

    renderController(data);
    renderModules(data.modules.items);
    renderSignals(cachedSignals, signalFilterInput.value);
    renderEvents(data.events);
  } catch (err) {
    setConnectionStatus("err", "Error");
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    refreshBtn.disabled = false;
  }
}

async function queryServerSignals(): Promise<void> {
  const filter = signalFilterInput.value.trim();
  const resp = await sendBgMessage<ExtensionResponse>({
    action: "getSignals",
    filter,
    limit: 100,
  });
  if (!resp.ok || !("signals" in resp)) {
    showError(resp.ok ? "Respuesta inesperada al listar senales." : resp.error);
    return;
  }
  cachedSignals = resp.signals;
  renderSignals(cachedSignals, filter);
}

async function handleReadSymbol(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const mod = symbolModuleInput.value.trim();
  const sym = symbolNameInput.value.trim();
  if (!mod || !sym) {
    symbolOutput.textContent = "Indique modulo y simbolo.";
    return;
  }

  symbolOutput.textContent = `Leyendo ${mod}/${sym}…`;
  try {
    const resp = await sendBgMessage<ExtensionResponse>({
      action: "readSymbol",
      module: mod,
      symbol: sym,
    });
    if (!resp.ok || !("symbolResult" in resp)) {
      symbolOutput.textContent = resp.ok ? "Error inesperado" : `Error: ${resp.error}`;
      return;
    }
    const sr = resp.symbolResult;
    symbolOutput.textContent = `${sr.task}/${sr.module}/${sr.symbol} = ${sr.value ?? "<null>"}`;
  } catch (err) {
    symbolOutput.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

refreshBtn.addEventListener("click", () => {
  void refreshDashboard();
});

signalFilterInput.addEventListener("input", () => {
  renderSignals(cachedSignals, signalFilterInput.value);
});

signalFilterBtn.addEventListener("click", () => {
  void queryServerSignals();
});

symbolForm.addEventListener("submit", (ev) => {
  void handleReadSymbol(ev);
});

openSidepanelBtn.addEventListener("click", async () => {
  if (!chrome.sidePanel?.open || !chrome.windows?.getCurrent) return;
  try {
    const win = await chrome.windows.getCurrent();
    if (typeof win.id === "number") {
      await chrome.sidePanel.open({ windowId: win.id });
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
});

void refreshDashboard();
