import { eulerZYX, IRB120_LIMITS, nOrient, orientZYX, parsePoseLiteral, poseMult, type Quat } from "mcp-robotstudio/kinematics";
import { generatePractice, type PracticeBlock, type PracticeResult } from "mcp-robotstudio/practice";
import { diffModules } from "mcp-robotstudio/rapid/diff";
import { validateRapidModule } from "mcp-robotstudio/rapid/validator";
import { checkRecipeWrite } from "mcp-robotstudio/recipes";
import { confData, inverseKinematics, type Joints } from "mcp-robotstudio/kinematics";
import type { EventLogEntry, IoSignalInfo } from "mcp-robotstudio/rws";
import { PRO_FEATURES, type ProFeature } from "./license.js";
import type { DashboardPayload, ExtensionRequest, ExtensionResponse } from "./storage.js";

// ---------------------------------------------------------------------------
// DOM helpers (textContent only: no innerHTML anywhere)
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function kv(label: string, value: string): HTMLDivElement {
  const item = el("div", "", "kv-item");
  item.append(el("span", label, "kv-label"), el("span", value, "kv-value"));
  return item;
}
function row(cells: Array<string | number | null | undefined>, monoFrom = 0): HTMLTableRowElement {
  const tr = el("tr");
  cells.forEach((c, i) => tr.append(el("td", c === null || c === undefined ? "-" : String(c), i >= monoFrom ? "mono" : "")));
  return tr;
}
const emptyRow = (cols: number, text: string) => {
  const tr = el("tr");
  const td = el("td", text);
  td.colSpan = cols;
  tr.append(td);
  return tr;
};
const fmt = (n: number | null | undefined, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? "-" : n.toFixed(d));

function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Loading state: the button that started a request shows aria-busy and the
// header shows an activity bar until every pending request/worker job ends.
let pending = 0;
let lastButton: HTMLButtonElement | null = null;
document.addEventListener(
  "click",
  (e) => {
    lastButton = (e.target as Element | null)?.closest("button") ?? lastButton;
  },
  true,
);
async function track<T>(p: Promise<T>): Promise<T> {
  const btn = lastButton;
  pending++;
  document.body.classList.add("busy");
  btn?.setAttribute("aria-busy", "true");
  try {
    return await p;
  } finally {
    pending--;
    btn?.removeAttribute("aria-busy");
    if (pending === 0) document.body.classList.remove("busy");
  }
}

async function send<T = unknown>(req: ExtensionRequest): Promise<T> {
  const resp = (await track(chrome.runtime.sendMessage(req))) as ExtensionResponse;
  if (!resp.ok) {
    if (resp.proRequired) showWall(undefined, resp.error);
    const err = new Error(resp.error) as Error & { proRequired?: boolean; writeModeRequired?: boolean };
    err.proRequired = resp.proRequired;
    err.writeModeRequired = resp.writeModeRequired;
    throw err;
  }
  return ("result" in resp ? resp.result : resp) as T;
}

function showError(msg: string | null): void {
  const b = $("error-banner");
  b.classList.toggle("hidden", !msg);
  b.textContent = msg ?? "";
}

async function guard(out: HTMLElement | null, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (out) out.textContent = `Error: ${msg}`;
    else showError(msg);
  }
}

// ---------------------------------------------------------------------------
// Plan, write mode and PRO walls
// ---------------------------------------------------------------------------
let plan: "free" | "pro" = "free";
let writeMode = false;

function showWall(feature?: ProFeature, reason?: string): void {
  $("license-dialog").classList.remove("hidden");
  $("license-reason").textContent =
    reason ?? `Esta funcion (pestana ${feature ? PRO_FEATURES[feature] : ""}) forma parte de la suscripcion unica MCP-ROBOTSTUDIO PRO.`;
}

function applyPlan(): void {
  const badge = $("plan-badge");
  badge.textContent = plan === "pro" ? "PRO" : "FREE";
  badge.className = `badge ${plan === "pro" ? "badge-pro" : ""}`;
  for (const card of Array.from(document.querySelectorAll<HTMLElement>(".pro, .pro-inline"))) {
    const feature = card.dataset.feature as ProFeature | undefined;
    let wall = card.querySelector<HTMLElement>(":scope > .pro-wall");
    if (plan === "pro") {
      card.classList.remove("locked");
      wall?.remove();
      continue;
    }
    card.classList.add("locked");
    if (!wall) {
      wall = el("div", "", "pro-wall");
      wall.append(el("span", "PRO", "badge badge-pro"), el("span", " Funcion de MCP-ROBOTSTUDIO PRO. "));
      const btn = el("button", "Activar PRO");
      btn.type = "button";
      btn.className = "upgrade";
      btn.addEventListener("click", () => showWall(feature));
      wall.append(btn);
      card.prepend(wall);
    }
  }
  const wb = $("write-badge");
  wb.textContent = writeMode ? "ESCRITURA ACTIVA" : "LECTURA";
  wb.className = `badge ${writeMode ? "badge-status-err" : "badge-readonly"}`;
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button.write"))) {
    b.disabled = plan !== "pro" || !writeMode;
    b.title = plan !== "pro" ? "Requiere PRO" : writeMode ? "" : "Active el modo escritura de sesion en Opciones";
  }
}

async function loadPlan(): Promise<void> {
  const lic = await send<{ plan: "free" | "pro"; subject?: string; expiresAt?: string; reason?: string }>({ action: "getLicense" });
  plan = lic.plan;
  writeMode = (await send<{ enabled: boolean }>({ action: "getWriteMode" })).enabled;
  $("license-status").textContent =
    lic.plan === "pro" ? `PRO activa (${lic.subject ?? "-"}, caduca ${lic.expiresAt?.slice(0, 10) ?? "-"})` : `Plan gratuito${lic.reason ? `: ${lic.reason}` : ""}`;
  applyPlan();
}

const needPro = (feature: ProFeature): boolean => {
  if (plan === "pro") return true;
  showWall(feature);
  return false;
};

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function selectTab(id: string): void {
  for (const t of Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"))) {
    const on = t.dataset.tab === id;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
  }
  for (const p of Array.from(document.querySelectorAll<HTMLElement>(".tab-panel"))) p.classList.toggle("hidden", p.id !== `panel-${id}`);
  try {
    localStorage.setItem("mcp-rs-tab", id);
  } catch {
    // storage unavailable
  }
}

// ---------------------------------------------------------------------------
// 01 TELEMETRIA Y CINEMATICA (+ shared dashboard data)
// ---------------------------------------------------------------------------
let cachedSignals: IoSignalInfo[] = [];
let lastExecState: string | null = null;
let lastForensic: unknown = null;
let lastForensicMd = "";

function setConnection(kind: "ok" | "warn" | "err", text: string): void {
  const b = $("connection-badge");
  b.className = `badge badge-status-${kind}`;
  b.textContent = text;
}

function renderDashboard(data: DashboardPayload): void {
  const { controller, joints, tcp } = data;
  const sys = controller.system;
  const panel = controller.panel;
  const t = controller.tasks[0];
  $("controller-grid").replaceChildren(
    kv("Controlador", `${sys.name ?? "-"} (RW ${sys.rwversion ?? "-"})`),
    kv("Motores (ctrlstate)", panel.ctrlstate ?? "-"),
    kv("Modo (opmode)", panel.opmode ?? "-"),
    kv("Ejecucion RAPID", `${panel.ctrlexecstate ?? "-"} (${panel.cycle ?? "-"})`),
    kv("Tarea principal", t ? `${t.name} / ${t.excstate ?? "-"} / ${t.active ?? "-"}` : controller.task),
    kv("Endpoint RWS", data.baseUrl),
  );
  const jointStr = joints?.jointsDeg?.length ? joints.jointsDeg.map((v, i) => `J${i + 1}:${v.toFixed(1)}`).join("  ") : "No disponible";
  const tcpStr =
    tcp && tcp.x !== null && tcp.y !== null && tcp.z !== null
      ? `X=${tcp.x.toFixed(1)}  Y=${tcp.y.toFixed(1)}  Z=${tcp.z.toFixed(1)} mm`
      : "No disponible";
  const qStr = tcp && tcp.q1 !== null ? `[${[tcp.q1, tcp.q2, tcp.q3, tcp.q4].map((v) => fmt(v, 5)).join(", ")}]` : "-";
  $("motion-grid").replaceChildren(kv("Ejes (deg)", jointStr), kv("TCP", tcpStr), kv("Cuaternion", qStr), kv("Ref.", `${tcp?.tool ?? "tool0"}/${tcp?.wobj ?? "wobj0"}`));

  const items = data.modules.items;
  $("modules-count").textContent = String(items.length);
  $("modules-body").replaceChildren(...(items.length ? items.map((m) => row([m.name, m.type ?? "-"])) : [emptyRow(2, "Sin modulos cargados.")]));

  renderEvents(data.events);
  cachedSignals = data.signals.signals;
  renderSignals();

  // 02: stop indicator (free) + auto forensic capture (PRO)
  const stopped = panel.ctrlexecstate === "stopped";
  const errors = data.events.filter((e) => e.type === "3");
  const ind = $("stop-indicator");
  ind.classList.toggle("hidden", !(stopped && errors.length > 0));
  ind.textContent = stopped && errors.length ? `Parada con ${errors.length} error(es) recientes: ${errors[0]?.code ?? ""} ${errors[0]?.title ?? ""}. Informe forense detallado: PRO.` : "";
  if (lastExecState === "running" && stopped && plan === "pro" && $<HTMLInputElement>("forensic-auto").checked) void captureForensic();
  lastExecState = panel.ctrlexecstate;
}

function renderEvents(events: EventLogEntry[]): void {
  const shown = events.slice(0, plan === "pro" ? 20 : 5);
  $("events-body").replaceChildren(
    ...(shown.length ? shown.map((ev) => row([ev.code, ev.title ?? ev.desc, ev.src, ev.time])) : [emptyRow(4, "Sin eventos recientes.")]),
  );
}

async function refreshDashboard(): Promise<void> {
  const btn = $<HTMLButtonElement>("refresh-btn");
  btn.disabled = true;
  setConnection("warn", "Consultando RWS");
  showError(null);
  try {
    const resp = (await chrome.runtime.sendMessage({ action: "getDashboardData" } satisfies ExtensionRequest)) as ExtensionResponse;
    if (!resp.ok || !("data" in resp)) {
      setConnection("err", "Sin conexion");
      showError(resp.ok ? "Respuesta inesperada." : resp.error);
      return;
    }
    $("http-warning").classList.toggle("hidden", resp.data.isLoopback || resp.data.baseUrl.startsWith("https:"));
    setConnection("ok", `${resp.data.controller.system.name ?? "Conectado"} OK`);
    renderDashboard(resp.data);
    if (plan === "pro") await refreshTelemetryPro();
  } catch (err) {
    setConnection("err", "Error");
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    btn.disabled = false;
  }
}

interface TelemetryPro {
  panel: { opmode: string | null; ctrlexecstate: string | null };
  speedRatio: number | null;
  speedAlert: boolean;
  cycleTimeFactor: number | null;
  pcp: { programPointer: { module: string | null; routine: string | null; beginLine: number | null; beginColumn: number | null; errorCode: string | null }; motionPointer: { module: string | null; routine: string | null; beginLine: number | null } } | null;
  joints: number[];
  mechunit: { status: string | null } | null;
  safety: { limitUsage: number[]; wrist: { singular: boolean; distanceDeg: number }; elbow: { singular: boolean; distanceDeg: number }; manipulability: number; manipulabilityRel: number; warnings: string[] } | null;
}

async function refreshTelemetryPro(): Promise<void> {
  const t = await send<TelemetryPro>({ action: "getTelemetryPro", tool: $<HTMLInputElement>("conv-tool").value, wobj: $<HTMLInputElement>("conv-wobj").value });
  const pp = t.pcp?.programPointer;
  const mp = t.pcp?.motionPointer;
  $("pcp-grid").replaceChildren(
    kv("PP", pp?.module ? `${pp.module} / ${pp.routine} / linea ${pp.beginLine}:${pp.beginColumn}` : `sin PP (${pp?.errorCode ?? "-"})`),
    kv("MP", mp?.module ? `${mp.module} / ${mp.routine} / linea ${mp.beginLine}` : "-"),
    kv("SpeedRatio", `${t.speedRatio ?? "-"} %`),
    kv("Penalizacion de ciclo", t.cycleTimeFactor ? `x${t.cycleTimeFactor.toFixed(2)} (${((t.cycleTimeFactor - 1) * 100).toFixed(0)} % mas lento)` : "-"),
    kv("SMB", t.mechunit?.status ?? "-"),
  );
  const alert = $("speed-alert");
  alert.classList.toggle("hidden", !t.speedAlert);
  alert.textContent = t.speedAlert ? `AUTO con SpeedRatio ${t.speedRatio} %: el ciclo tarda x${t.cycleTimeFactor?.toFixed(2)}.` : "";

  const bars = $("limit-bars");
  bars.replaceChildren(
    ...t.joints.slice(0, 6).map((v, i) => {
      const lim = IRB120_LIMITS[i]!;
      const pct = ((v - lim.min) / (lim.max - lim.min)) * 100;
      const usage = t.safety?.limitUsage[i] ?? 0;
      const wrap = el("div", "", "bar-row");
      const label = el("span", `J${i + 1}`, "mono");
      const track = el("div", "", "bar-track");
      const mark = el("div", "", `bar-mark ${usage > 0.9 ? "crit" : usage > 0.75 ? "warn" : ""}`);
      mark.style.left = `${Math.max(0, Math.min(100, pct))}%`;
      track.append(mark);
      wrap.append(label, track, el("span", `${v.toFixed(2)} [${lim.min}, ${lim.max}]`, "mono"));
      return wrap;
    }),
  );
  const s = t.safety;
  $("singularity-grid").replaceChildren(
    kv("Muneca |J5|", s ? `${s.wrist.distanceDeg.toFixed(2)} deg ${s.wrist.singular ? "SINGULAR (< 3)" : "OK"}` : "-"),
    kv("Codo (q3 estirado -76.95)", s ? `${s.elbow.distanceDeg.toFixed(2)} deg ${s.elbow.singular ? "CERCA" : "OK"}` : "-"),
    kv("Manipulabilidad (Yoshikawa)", s ? `w=${s.manipulability.toExponential(3)} rel=${s.manipulabilityRel.toFixed(3)}` : "-"),
    kv("Avisos", s?.warnings.join("; ") || "ninguno"),
  );
}

function poseConverter(): void {
  const out = $("pc-out");
  try {
    const q = orientZYX(Number($<HTMLInputElement>("pc-ez").value), Number($<HTMLInputElement>("pc-ey").value), Number($<HTMLInputElement>("pc-ex").value));
    const a = parsePoseLiteral($<HTMLInputElement>("pc-pose-a").value);
    const b = parsePoseLiteral($<HTMLInputElement>("pc-pose-b").value);
    const e = eulerZYX(a.rot);
    const m = poseMult({ trans: a.trans, rot: nOrient(a.rot) }, { trans: b.trans, rot: nOrient(b.rot) });
    out.textContent = [
      `OrientZYX(Ez,Ey,Ex) = [${q.map((v) => v.toFixed(6)).join(", ")}]`,
      `EulerZYX(A)         = Z ${e.z.toFixed(4)}  Y ${e.y.toFixed(4)}  X ${e.x.toFixed(4)} deg`,
      `NOrient(A)          = [${nOrient(a.rot).map((v) => v.toFixed(6)).join(", ")}]`,
      `PoseMult(A,B)       = [[${m.trans.map((v) => v.toFixed(3)).join(",")}],[${m.rot.map((v) => v.toFixed(6)).join(",")}]]`,
    ].join("\n");
  } catch (err) {
    out.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// 02 FORENSE Y DIFF
// ---------------------------------------------------------------------------
async function captureForensic(): Promise<void> {
  if (!needPro("forensicCapture")) return;
  const out = $("forensic-out");
  out.textContent = "Capturando...";
  await guard(out, async () => {
    const rep = await send<{ markdown: string }>({ action: "captureForensic", contextLines: 5 });
    lastForensic = rep;
    lastForensicMd = rep.markdown;
    out.textContent = rep.markdown;
  });
}

async function readFileInput(id: string): Promise<{ name: string; text: string; bytes: ArrayBuffer } | null> {
  const f = $<HTMLInputElement>(id).files?.[0];
  if (!f) return null;
  const bytes = await f.arrayBuffer();
  return { name: f.name, text: new TextDecoder().decode(bytes), bytes };
}

async function runDiff(): Promise<void> {
  if (!needPro("timeMachineDiff")) return;
  const out = $("diff-out");
  await guard(out, async () => {
    const golden = await readFileInput("diff-file");
    if (!golden) throw new Error("elija el archivo Golden Master .mod");
    const mod = $<HTMLInputElement>("diff-module").value.trim();
    const live = await send<{ source: string }>({ action: "readModuleSource", module: mod });
    const d = diffModules(golden.text, live.source);
    $("diff-summary").textContent = d.identical ? `IDENTICO: ${mod} en RAM = ${golden.name}` : `DIFERENTE: +${d.added} / -${d.removed} lineas (${mod} en RAM frente a ${golden.name})`;
    out.replaceChildren(
      ...d.unified.split("\n").map((l) => el("span", `${l}\n`, l.startsWith("+") ? "diff-add" : l.startsWith("-") ? "diff-del" : l.startsWith("@@") ? "diff-hunk" : "")),
    );
  });
}

async function runValidator(): Promise<string> {
  const file = await readFileInput("val-file");
  if (file) $<HTMLTextAreaElement>("val-src").value = file.text;
  const src = $<HTMLTextAreaElement>("val-src").value;
  const r = validateRapidModule(src, { checkReach: $<HTMLInputElement>("val-reach").checked });
  $("val-out").textContent = [
    `${r.ok ? "VALIDO" : "CON ERRORES"}: modulo ${r.moduleName ?? "-"}, errores ${r.errors}, avisos ${r.warnings}`,
    ...r.diagnostics.map((d) => `${d.severity.toUpperCase().padEnd(7)} L${String(d.line).padStart(4)}:${d.column} ${d.code} ${d.message}`),
    ...r.robtargets.map((t) => `robtarget ${t.name} |q|=${t.quatNorm.toFixed(6)}${t.reach ? ` alcanza=${t.reach.reachable}` : ""}`),
  ].join("\n");
  return src;
}

// ---------------------------------------------------------------------------
// 03 OSCILOSCOPIO Y FLOTA
// ---------------------------------------------------------------------------
function renderSignals(): void {
  const q = $<HTMLInputElement>("signal-filter").value.trim().toLowerCase();
  const visible = q ? cachedSignals.filter((s) => s.name.toLowerCase().includes(q)) : cachedSignals;
  $("signals-count").textContent = `${visible.length}/${cachedSignals.length}`;
  if (!visible.length) {
    $("signals-body").replaceChildren(emptyRow(5, "No hay senales que coincidan con el filtro."));
    return;
  }
  $("signals-body").replaceChildren(
    ...visible.map((sig) => {
      const tr = el("tr");
      const td = el("td");
      const cb = el("input");
      cb.type = "checkbox";
      cb.className = "scope-sig";
      cb.value = sig.name;
      cb.disabled = plan !== "pro";
      td.append(cb);
      tr.append(td, el("td", sig.name, "mono"), el("td", sig.type ?? "-"), el("td", sig.value ?? "-", "mono"), el("td", sig.state ?? "-"));
      return tr;
    }),
  );
}

interface Series {
  name: string;
  digital: boolean;
  color: string;
  points: Array<[number, number]>;
}
// trace colours: distinct hues at similar lightness on the dark ground
const COLORS = ["#39b5e0", "#3fb950", "#d29922", "#f85149", "#a371f7", "#2bc0a8", "#db61a2", "#e3b341", "#e6edf3", "#9aa7b4", "#f0883e"];
const series = new Map<string, Series>();
let scopeRunning = false;
let lastSampleT = 0;

function seriesFor(name: string, digital: boolean): Series {
  let s = series.get(name);
  if (!s) {
    s = { name, digital, color: COLORS[series.size % COLORS.length]!, points: [] };
    series.set(name, s);
  }
  return s;
}

function drawScope(): void {
  const canvas = $<HTMLCanvasElement>("scope-canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;
  const win = Number($<HTMLInputElement>("scope-window").value || 20) * 1000;
  const now = lastSampleT || performance.timeOrigin + performance.now();
  ctx.fillStyle = "#0b0f14";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#1c232d";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 10; i++) {
    const x = (i / 10) * W;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  const all = [...series.values()];
  const digital = all.filter((s) => s.digital);
  const analog = all.filter((s) => !s.digital);
  const laneH = digital.length ? Math.min(28, (H * 0.5) / digital.length) : 0;
  ctx.font = "10px ui-monospace, Consolas, monospace";
  digital.forEach((s, i) => {
    const y0 = 6 + i * laneH;
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    let prevY: number | null = null;
    for (const [t, v] of s.points) {
      if (t < now - win) continue;
      const x = W - ((now - t) / win) * W;
      const y = y0 + (v ? 2 : laneH - 6);
      if (prevY === null) ctx.moveTo(x, y);
      else {
        ctx.lineTo(x, prevY);
        ctx.lineTo(x, y);
      }
      prevY = y;
    }
    if (prevY !== null) ctx.lineTo(W, prevY);
    ctx.stroke();
    ctx.fillStyle = s.color;
    ctx.fillText(s.name, 4, y0 + 10);
  });
  const top = 6 + digital.length * laneH;
  const vals = analog.flatMap((s) => s.points.filter(([t]) => t >= now - win).map(([, v]) => v));
  if (vals.length) {
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    for (const s of analog) {
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      let first = true;
      for (const [t, v] of s.points) {
        if (t < now - win) continue;
        const x = W - ((now - t) / win) * W;
        const y = H - 6 - ((v - min) / span) * (H - top - 12);
        if (first) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        first = false;
      }
      ctx.stroke();
    }
    ctx.fillStyle = "#9aa7b4";
    ctx.fillText(`${max.toFixed(2)}`, W - 60, top + 10);
    ctx.fillText(`${min.toFixed(2)}`, W - 60, H - 8);
  }
  $("scope-legend").textContent = all
    .map((s) => {
      const last = s.points[s.points.length - 1];
      return `${s.name}=${last ? (s.digital ? last[1] : last[1].toFixed(2)) : "-"}`;
    })
    .join("  ") + (lastSampleT ? `  t=${new Date(lastSampleT).toISOString().slice(11, 23)}` : "");
  if (scopeRunning) requestAnimationFrame(drawScope);
}

function onScopeMessage(m: { channel?: string; kind?: string; t?: number; uri?: string; values?: Record<string, string>; x?: number; y?: number; z?: number; mode?: string; reason?: string; message?: string }): void {
  if (m.channel !== "scope") return;
  const t = m.t ?? Date.now();
  lastSampleT = t;
  const cut = t - 300_000;
  const push = (s: Series, v: number) => {
    s.points.push([t, v]);
    while (s.points.length && s.points[0]![0] < cut) s.points.shift();
  };
  if (m.kind === "event" && m.uri && m.values) {
    const sig = /\/signals\/(.+);state$/.exec(m.uri);
    if (sig) push(seriesFor(sig[1]!.split("/").pop()!, true), Number(m.values.lvalue ?? 0));
    const sym = /\/RAPID\/[^/]+\/([^/]+)\/([^/;]+)/.exec(m.uri);
    if (sym && m.values.value !== undefined && Number.isFinite(Number(m.values.value))) push(seriesFor(`${sym[2]}`, false), Number(m.values.value));
  } else if (m.kind === "tcp") {
    if (m.x !== undefined) push(seriesFor("TCP X", false), m.x);
    if (m.y !== undefined) push(seriesFor("TCP Y", false), m.y);
    if (m.z !== undefined) push(seriesFor("TCP Z", false), m.z);
  } else if (m.kind === "mode") {
    $("scope-status").textContent = `${m.mode}${m.reason ? ` (${m.reason})` : ""}`;
  } else if (m.kind === "error") {
    $("scope-status").textContent = `error: ${m.message}`;
  }
}

async function startScope(): Promise<void> {
  if (!needPro("oscilloscope")) return;
  const sigs = Array.from(document.querySelectorAll<HTMLInputElement>("input.scope-sig:checked")).map((c) => c.value).slice(0, 8);
  const pers = $<HTMLInputElement>("scope-pers").value.split(",").map((s) => s.trim()).filter(Boolean);
  const task = "T_ROB1";
  const resources = [
    ...sigs.map((s) => ({ uri: `/rw/iosystem/signals/${s};state`, priority: 1 as const })),
    ...pers.map((p) => ({ uri: `/rw/rapid/symbol/data/RAPID/${task}/${p};value`, priority: 1 as const })),
    { uri: "/rw/rapid/execution;ctrlexecstate", priority: 1 as const },
  ];
  series.clear();
  await guard($("scope-status"), async () => {
    await send({ action: "startScope", resources, tcpPollMs: $<HTMLInputElement>("scope-tcp").checked ? 200 : 0 });
    scopeRunning = true;
    $("scope-status").textContent = "conectando";
    requestAnimationFrame(drawScope);
  });
}

const certRows: Array<{ at: string; errorMm: number; errorDeg: number | null; pass: boolean }> = [];

function certExport(kind: "csv" | "md"): void {
  if (!needPro("storePathCertifier")) return;
  const tol = Number($<HTMLInputElement>("cert-tol").value);
  if (kind === "csv") {
    download("certificado-storepath.csv", ["hora,error_mm,error_deg,resultado", ...certRows.map((r) => `${r.at},${r.errorMm.toFixed(4)},${r.errorDeg?.toFixed(4) ?? ""},${r.pass ? "OK" : "FALLO"}`)].join("\n"), "text/csv");
  } else {
    download(
      "certificado-storepath.md",
      [`# Certificado de retorno StorePath/RestoPath`, "", `Tolerancia: ${tol} mm`, "", "| Hora | Error mm | Error deg | Resultado |", "|---|---|---|---|", ...certRows.map((r) => `| ${r.at} | ${r.errorMm.toFixed(4)} | ${r.errorDeg?.toFixed(4) ?? "-"} | ${r.pass ? "OK" : "FALLO"} |`)].join("\n"),
      "text/markdown",
    );
  }
}

// ---------------------------------------------------------------------------
// 04 ALCANCE Y RECETAS
// ---------------------------------------------------------------------------
const parseList = (s: string) => s.split(";").map((p) => p.trim().split(/[\s,]+/).map(Number)).filter((a) => a.length === 3 && a.every(Number.isFinite)) as Array<[number, number, number]>;
const toolPose = (s: string) => (s.trim() ? parsePoseLiteral(s.replace(/^\s*\[\s*(TRUE|FALSE)\s*,/i, "[")) : undefined);

function runReachProbe(): void {
  if (!needPro("reachProbe")) return;
  const out = $("rp-out");
  try {
    const base = { x: Number($<HTMLInputElement>("rp-x").value), y: Number($<HTMLInputElement>("rp-y").value), z: Number($<HTMLInputElement>("rp-z").value) };
    const q = JSON.parse($<HTMLInputElement>("rp-q").value) as Quat;
    const tool = toolPose($<HTMLInputElement>("rp-tool").value);
    const offs: Array<[number, number, number]> = [[0, 0, 0], ...parseList($<HTMLInputElement>("rp-offs").value)];
    const tilts = $<HTMLInputElement>("rp-tilts").value.split(/[\s,]+/).map(Number).filter(Number.isFinite);
    const e = eulerZYX(q);
    const rows: HTMLTableRowElement[] = [];
    let best: string | null = null;
    for (const tilt of tilts.length ? tilts : [0]) {
      for (const axis of tilt === 0 ? ["-"] : ["X", "Y"]) {
        const rot = axis === "-" ? nOrient(q) : axis === "X" ? orientZYX(e.z, e.y, e.x + tilt) : orientZYX(e.z, e.y + tilt, e.x);
        let all = true;
        for (const [dx, dy, dz] of offs) {
          const ik = inverseKinematics({ trans: [base.x + dx, base.y + dy, base.z + dz], rot }, { tool });
          all &&= ik.reachable;
          rows.push(row([tilt, axis, `${dx},${dy},${dz}`, ik.reachable ? "SI" : "NO", ik.joints?.map((v) => v.toFixed(1)).join(" ") ?? "-", ik.joints ? Math.abs(ik.joints[4]).toFixed(1) : "-"], 2));
        }
        if (all && !best) best = `Primera orientacion valida: inclinacion ${tilt} deg eje ${axis} -> q=[${rot.map((v) => v.toFixed(6)).join(",")}]`;
      }
    }
    $("rp-body").replaceChildren(...rows);
    out.textContent = best ?? "Ninguna orientacion probada alcanza el punto y todos sus Offs.";
  } catch (err) {
    out.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function recipeCheck(): Promise<ReturnType<typeof checkRecipeWrite>> {
  const mod = $<HTMLInputElement>("rc-module").value.trim();
  const sym = $<HTMLInputElement>("rc-symbol").value.trim();
  const cur = (await send<ExtensionResponse & { symbolResult?: { value: string | null } }>({ action: "readSymbol", module: mod, symbol: sym })) as unknown as { symbolResult: { value: string | null } };
  const next = $<HTMLTextAreaElement>("rc-value").value.trim();
  const shield = checkRecipeWrite("robtarget", cur.symbolResult.value, next, { deltaMaxMm: Number($<HTMLInputElement>("rc-delta").value), tool: toolPose($<HTMLInputElement>("rp-tool").value) });
  $("rc-out").textContent = [`actual: ${cur.symbolResult.value}`, `nuevo : ${next}`, shield.allowed ? "ESCUDO: PERMITIDO" : `ESCUDO: BLOQUEADO\n- ${shield.reasons.join("\n- ")}`, JSON.stringify(shield.details)].join("\n");
  return shield;
}

// ---------------------------------------------------------------------------
// 05 ESTUDIO DE PRACTICAS
// ---------------------------------------------------------------------------
interface Knowledge {
  checklist: Array<{ section: string; items: string[] }>;
  incidents: Array<{ category: string; id: string; summary: string }>;
  topics: string[];
}
let knowledge: Knowledge | null = null;
let worker: Worker | null = null;
let rspagBytes: ArrayBuffer | null = null;
let rspagName = "";
let generated: PracticeResult | null = null;
let liveAudit: { signals: IoSignalInfo[]; tools: Array<{ name: string; value: string }>; wobjs: Array<{ name: string; value: string }> } | null = null;

async function loadKnowledge(): Promise<void> {
  knowledge = (await (await fetch(chrome.runtime.getURL("knowledge.json"))).json()) as Knowledge;
  let state: Record<string, boolean> = {};
  try {
    state = JSON.parse(localStorage.getItem("mcp-rs-checklist") ?? "{}") as Record<string, boolean>;
  } catch {
    state = {};
  }
  const root = $("checklist");
  root.replaceChildren();
  knowledge.checklist.forEach((sec, si) => {
    root.append(el("h3", sec.section));
    sec.items.forEach((item, ii) => {
      const key = `${si}.${ii}`;
      const label = el("label", "", "check");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = state[key] === true;
      cb.addEventListener("change", () => {
        state[key] = cb.checked;
        try {
          localStorage.setItem("mcp-rs-checklist", JSON.stringify(state));
        } catch {
          // storage unavailable
        }
      });
      label.append(cb, el("span", ` ${item}`));
      root.append(label);
    });
  });
}

function runWorker<T>(job: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  worker ??= new Worker(chrome.runtime.getURL("rspag-worker.js"), { type: "module" });
  const id = Math.random();
  return track(new Promise<T>((resolve, reject) => {
    const w = worker!;
    const onMsg = (ev: MessageEvent<{ id: number; ok: boolean; error?: string }>) => {
      if (ev.data.id !== id) return;
      w.removeEventListener("message", onMsg);
      if (ev.data.ok) resolve(ev.data as T);
      else reject(new Error(ev.data.error));
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ id, ...job }, transfer);
  }));
}

interface AuditReport {
  verdict: string;
  entries: number;
  projectName: string | null;
  controllers: Array<{ name: string; systemGuid: string | null; templateGuid: string | null; guidsWellFormed: boolean; backupProjectName: string | null; issues: string[] }>;
  privacy: Array<{ entry: string; kind: string; match: string }>;
  pngs: Array<{ entry: string; metadataChunks: string[] }>;
  issues: string[];
}

function formatAudit(r: AuditReport): string {
  return [
    `VEREDICTO: ${r.verdict.toUpperCase()}  (${r.entries} entradas, proyecto ${r.projectName ?? "-"})`,
    ...r.controllers.map((c) => `controlador ${c.name}: system.guid ${c.systemGuid ?? "FALTA"} | template.guid ${c.templateGuid ?? "FALTA"} | ${c.guidsWellFormed ? "GUID OK" : "GUID MAL"} | backup de ${c.backupProjectName ?? "-"}`),
    `fugas de privacidad: ${r.privacy.length}`,
    ...r.privacy.slice(0, 20).map((p) => `  ${p.kind} en ${p.entry}`),
    `PNG con metadatos: ${r.pngs.filter((p) => p.metadataChunks.length).map((p) => `${p.entry} [${p.metadataChunks.join(",")}]`).join("; ") || "ninguno"}`,
    ...r.issues.map((i) => `- ${i}`),
  ].join("\n");
}

async function auditRspagFile(file: File): Promise<void> {
  const out = $("rspag-out");
  out.textContent = `Auditando ${file.name} en Web Worker...`;
  rspagName = file.name;
  rspagBytes = await file.arrayBuffer();
  await guard(out, async () => {
    const res = await runWorker<{ report: AuditReport }>({ op: "audit", buffer: rspagBytes!.slice(0) });
    out.textContent = formatAudit(res.report);
  });
}

function wizardSpec() {
  const pts = $<HTMLTextAreaElement>("wz-points").value
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 4)
    .map((p) => ({ name: p[0]!, xyz: [Number(p[1]), Number(p[2]), Number(p[3])] as [number, number, number] }));
  const toolStr = $<HTMLInputElement>("wz-tool").value.trim();
  const [toolName, ...rest] = toolStr.split(/\s+/);
  const pose = rest.length ? toolPose(rest.join(" ")) : undefined;
  const di = $<HTMLInputElement>("wz-di").value.trim();
  const dout = $<HTMLInputElement>("wz-do").value.trim();
  return {
    block: $<HTMLSelectElement>("wz-block").value as PracticeBlock,
    moduleName: $<HTMLInputElement>("wz-module").value.trim(),
    behavior: $<HTMLSelectElement>("wz-behavior").value as "practica" | "final",
    points: pts,
    approachMm: Number($<HTMLInputElement>("wz-approach").value),
    ...(di ? { inputSignal: di } : {}),
    ...(dout ? { gripperSignal: dout } : {}),
    ...(toolName && pose ? { tool: { name: toolName, pose } } : {}),
    ...(liveAudit ? { availableSignals: liveAudit.signals.map((s) => s.name) } : {}),
  };
}

const BLOCK_KEYWORDS: Record<PracticeBlock, RegExp> = {
  trayectorias: /alcance|orientacion|loadmod|modulos/i,
  saltos: /DI|senal|signal|rws/i,
  offs: /alcance|offs|orientacion|insercion/i,
  pickplace: /attacher|colision|smart|interrup|mytool|storepath/i,
};

function generate(): void {
  if (!needPro("practiceWizard")) return;
  const out = $("wz-out");
  try {
    const spec = wizardSpec();
    generated = generatePractice(spec);
    out.textContent = `${generated.module}\n----- README.md -----\n${generated.readme}`;
    const rel = knowledge?.incidents.filter((i) => BLOCK_KEYWORDS[spec.block].test(`${i.id} ${i.summary}`)) ?? [];
    const box = $("wz-incidents");
    box.replaceChildren(...(rel.length ? [el("h3", "Incidentes del curso relacionados"), ...rel.map((i) => el("div", `[${i.category}] ${i.id}: ${i.summary}`))] : []));
  } catch (err) {
    out.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire(): void {
  for (const t of Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"))) t.addEventListener("click", () => selectTab(t.dataset.tab!));
  $("refresh-btn").addEventListener("click", () => void refreshDashboard());
  $("open-sidepanel-btn").addEventListener("click", async () => {
    if (!chrome.sidePanel?.open || !chrome.windows?.getCurrent) return;
    const win = await chrome.windows.getCurrent();
    if (typeof win.id === "number") await chrome.sidePanel.open({ windowId: win.id }).catch(() => undefined);
  });
  $("license-close").addEventListener("click", () => $("license-dialog").classList.add("hidden"));
  $("license-activate").addEventListener("click", () =>
    void guard($("license-status"), async () => {
      const st = await send<{ plan: string; reason?: string }>({ action: "activateLicense", token: $<HTMLInputElement>("license-token").value });
      $("license-status").textContent = st.plan === "pro" ? "Licencia PRO activada." : `No valida: ${st.reason ?? ""}`;
      await loadPlan();
      renderSignals();
    }),
  );

  // 01
  $("speed-fix-btn").addEventListener("click", () =>
    void guard($("speed-fix-out"), async () => {
      const r = await send<{ speedRatio: number | null }>({ action: "setSpeedRatio", ratio: 100 });
      $("speed-fix-out").textContent = `SpeedRatio = ${r.speedRatio} %`;
      await refreshTelemetryPro();
    }),
  );
  $("pc-run").addEventListener("click", () => (needPro("poseConverter") ? poseConverter() : undefined));
  $("conv-read-tcp").addEventListener("click", () => (needPro("poseConverter") ? void guard($("pc-out"), refreshTelemetryPro) : undefined));

  // 02
  $("forensic-btn").addEventListener("click", () => void captureForensic());
  $("forensic-json").addEventListener("click", () => needPro("forensicCapture") && lastForensic && download("forense.json", JSON.stringify(lastForensic, null, 2), "application/json"));
  $("forensic-md").addEventListener("click", () => needPro("forensicCapture") && lastForensicMd && download("forense.md", lastForensicMd, "text/markdown"));
  $("diff-btn").addEventListener("click", () => void runDiff());
  $("val-btn").addEventListener("click", () => (needPro("offlineValidator") ? void guard($("val-out"), async () => void (await runValidator())) : undefined));
  $("load-btn").addEventListener("click", () =>
    void guard($("val-out"), async () => {
      const src = await runValidator();
      const name = `${/MODULE\s+(\w+)/i.exec(src)?.[1] ?? "Modulo"}.mod`;
      const r = await send<{ loaded: boolean; stage: string; controller?: { reason?: string; modules: string[] } }>({ action: "loadModuleSafe", fileName: name, content: src });
      $("val-out").textContent += `\n\nCARGA (${r.stage}): ${r.loaded ? "OK, modulo presente en /rw/rapid/modules y sin errores nuevos en /rw/elog/0" : `FALLO ${r.controller?.reason ?? "validacion offline"}`}`;
    }),
  );

  // 03
  $("signal-filter").addEventListener("input", renderSignals);
  $("signal-filter-btn").addEventListener("click", () =>
    void guard(null, async () => {
      const r = (await chrome.runtime.sendMessage({ action: "getSignals", filter: $<HTMLInputElement>("signal-filter").value.trim(), limit: 100 } satisfies ExtensionRequest)) as ExtensionResponse;
      if (r.ok && "signals" in r) {
        cachedSignals = r.signals;
        renderSignals();
      }
    }),
  );
  $("scope-start").addEventListener("click", () => void startScope());
  $("scope-stop").addEventListener("click", () =>
    void guard($("scope-status"), async () => {
      scopeRunning = false;
      await send({ action: "stopScope" });
      $("scope-status").textContent = "detenido";
    }),
  );
  chrome.runtime.onMessage.addListener((m: unknown) => {
    onScopeMessage(m as Parameters<typeof onScopeMessage>[0]);
    return false;
  });
  $("cert-btn").addEventListener("click", () => {
    if (!needPro("storePathCertifier")) return;
    void guard(null, async () => {
      const r = await send<{ errorMm: number; errorDeg: number | null; at: string }>({
        action: "getStorePathCert",
        module: $<HTMLInputElement>("cert-module").value.trim(),
        stopSymbol: $<HTMLInputElement>("cert-stop").value.trim(),
        returnSymbol: $<HTMLInputElement>("cert-back").value.trim(),
      });
      const pass = r.errorMm <= Number($<HTMLInputElement>("cert-tol").value);
      certRows.push({ at: r.at, errorMm: r.errorMm, errorDeg: r.errorDeg, pass });
      $("cert-body").replaceChildren(...certRows.map((c) => row([c.at.slice(11, 23), c.errorMm.toFixed(4), fmt(c.errorDeg, 4), c.pass ? "OK" : "FALLO"], 0)));
    });
  });
  $("cert-csv").addEventListener("click", () => certExport("csv"));
  $("cert-md").addEventListener("click", () => certExport("md"));
  $("fleet-btn").addEventListener("click", () => {
    if (!needPro("fleetDashboard")) return;
    void guard(null, async () => {
      const r = await send<{ rows: Array<Record<string, unknown>> }>({ action: "getFleet" });
      $("fleet-body").replaceChildren(
        ...r.rows.map((c) => (c.error ? row([String(c.cell), `ERROR ${String(c.error)}`, "", "", "", "", "", ""]) : row([c.cell as string, `${c.system as string} RW ${c.rw as string}`, c.dialect as string, c.opmode as string, c.ctrlstate as string, c.exec as string, `${c.speedRatio as number} %`, c.smbSync as string], 1))),
      );
    });
  });
  $("backup-btn").addEventListener("click", () =>
    void guard($("backup-out"), async () => {
      const r = await send({ action: "triggerBackup", dirName: $<HTMLInputElement>("backup-dir").value.trim() });
      $("backup-out").textContent = JSON.stringify(r, null, 2);
    }),
  );

  // 04
  $("symbol-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const mod = $<HTMLInputElement>("symbol-module").value.trim();
    const sym = $<HTMLInputElement>("symbol-name").value.trim();
    const out = $("symbol-output");
    if (!mod || !sym) {
      out.textContent = "Indique modulo y simbolo.";
      return;
    }
    out.textContent = `Leyendo ${mod}/${sym}`;
    void (async () => {
      const resp = (await chrome.runtime.sendMessage({ action: "readSymbol", module: mod, symbol: sym } satisfies ExtensionRequest)) as ExtensionResponse;
      out.textContent = resp.ok && "symbolResult" in resp ? `${resp.symbolResult.task}/${resp.symbolResult.module}/${resp.symbolResult.symbol} = ${resp.symbolResult.value ?? "<null>"}` : `Error: ${resp.ok ? "inesperado" : resp.error}`;
    })();
  });
  $("conv-e2q").addEventListener("click", () => {
    const q = orientZYX(Number($<HTMLInputElement>("conv-ez").value), Number($<HTMLInputElement>("conv-ey").value), Number($<HTMLInputElement>("conv-ex").value));
    $("conv-out").textContent = `[${q.map((v) => v.toFixed(6)).join(",")}]`;
  });
  $("conv-q2e").addEventListener("click", () => {
    try {
      const e = eulerZYX(JSON.parse($<HTMLInputElement>("conv-q").value) as Quat);
      $("conv-out").textContent = `Z ${e.z.toFixed(4)}  Y ${e.y.toFixed(4)}  X ${e.x.toFixed(4)} deg`;
    } catch (err) {
      $("conv-out").textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  });
  $("rp-btn").addEventListener("click", runReachProbe);
  $("tb-btn").addEventListener("click", () => {
    if (!needPro("teachByShowing")) return;
    void guard($("tb-out"), async () => {
      const tool = $<HTMLInputElement>("tb-tool").value.trim();
      const wobj = $<HTMLInputElement>("tb-wobj").value.trim();
      const t = await send<{ tcp: { x: number; y: number; z: number; q1: number; q2: number; q3: number; q4: number; cf1: number; cf4: number; cf6: number; cfx: number } | null; joints: number[] }>({ action: "getTelemetryPro", tool, wobj });
      if (!t.tcp) throw new Error("TCP no disponible");
      const c = t.tcp;
      const conf = t.joints.length === 6 ? confData(t.joints as Joints) : [c.cf1, c.cf4, c.cf6, c.cfx];
      $("tb-out").textContent = `CONST robtarget ${$<HTMLInputElement>("tb-name").value.trim()}:=[[${[c.x, c.y, c.z].map((v) => v.toFixed(2)).join(",")}],[${[c.q1, c.q2, c.q3, c.q4].map((v) => v.toFixed(6)).join(",")}],[${conf.join(",")}],[9E9,9E9,9E9,9E9,9E9,9E9]];\n! capturado con ${tool}\\WObj:=${wobj}, joints [${t.joints.map((v) => v.toFixed(2)).join(", ")}]`;
    });
  });
  $("rc-load").addEventListener("click", () =>
    void guard($("rc-out"), async () => {
      const r = (await chrome.runtime.sendMessage({ action: "readSymbol", module: $<HTMLInputElement>("rc-module").value.trim(), symbol: $<HTMLInputElement>("rc-symbol").value.trim() } satisfies ExtensionRequest)) as ExtensionResponse;
      if (r.ok && "symbolResult" in r) $<HTMLTextAreaElement>("rc-value").value = r.symbolResult.value ?? "";
      $("rc-out").textContent = r.ok ? "Valor actual cargado." : `Error: ${r.error}`;
    }),
  );
  $("rc-check").addEventListener("click", () => (needPro("recipeEditor") ? void guard($("rc-out"), async () => void (await recipeCheck())) : undefined));
  $("rc-write").addEventListener("click", () =>
    void guard($("rc-out"), async () => {
      const shield = await recipeCheck();
      if (!shield.allowed) return;
      const r = await send<{ written: boolean; shield: { reasons: string[] } }>({
        action: "writeRecipe",
        module: $<HTMLInputElement>("rc-module").value.trim(),
        symbol: $<HTMLInputElement>("rc-symbol").value.trim(),
        value: $<HTMLTextAreaElement>("rc-value").value.trim(),
        deltaMaxMm: Number($<HTMLInputElement>("rc-delta").value),
        tool: $<HTMLInputElement>("rp-tool").value,
      });
      $("rc-out").textContent += `\nESCRITURA: ${r.written ? "OK" : `BLOQUEADA ${r.shield.reasons.join("; ")}`}`;
    }),
  );

  // 05
  const input = $<HTMLInputElement>("rspag-input");
  input.addEventListener("change", () => input.files?.[0] && void auditRspagFile(input.files[0]));
  const drop = $("rspag-drop");
  drop.addEventListener("dragover", (e) => e.preventDefault());
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void auditRspagFile(f);
  });
  $("rspag-anon").addEventListener("click", () => {
    if (!needPro("rspagAnonymizer")) return;
    if (!rspagBytes) {
      $("rspag-out").textContent = "Elija primero un .rspag.";
      return;
    }
    void guard($("rspag-out"), async () => {
      const r = await runWorker<{ report: AuditReport; data: Uint8Array; preview?: Uint8Array; changedEntries: string[] }>({ op: "anonymize", buffer: rspagBytes!.slice(0) });
      $("rspag-out").textContent = `Entradas modificadas: ${r.changedEntries.length}\n${r.changedEntries.join("\n")}\n\nRE-AUDITORIA DEL RESULTADO\n${formatAudit(r.report)}`;
      download(rspagName.replace(/\.rspag$/i, "") + "_anonimizado.rspag", r.data as BlobPart, "application/zip");
      if (r.preview) (window as unknown as { __preview?: Uint8Array }).__preview = r.preview;
    });
  });
  $("rspag-preview").addEventListener("click", () => {
    if (!needPro("rspagAnonymizer")) return;
    const p = (window as unknown as { __preview?: Uint8Array }).__preview;
    if (p) download("Preview.png", p as BlobPart, "image/png");
    else $("rspag-out").textContent = "Anonimice primero el .rspag para obtener el Preview.png limpio.";
  });
  $("wz-audit").addEventListener("click", () => {
    if (!needPro("practiceWizard")) return;
    void guard($("wz-audit-out"), async () => {
      liveAudit = await send({ action: "getLiveAudit" });
      $("wz-audit-out").textContent = [
        `EIO: ${liveAudit!.signals.length} senales (${liveAudit!.signals.filter((s) => !/^DRV/.test(s.name)).map((s) => `${s.name}:${s.type}`).join(", ") || "solo DRV*"})`,
        `CalibData tooldata: ${liveAudit!.tools.map((t) => `${t.name}=${t.value}`).join(" | ") || "ninguna"}`,
        `CalibData wobjdata: ${liveAudit!.wobjs.map((t) => t.name).join(", ") || "ninguno (wobj0)"}`,
      ].join("\n");
      const first = liveAudit!.tools[0];
      if (first) $<HTMLInputElement>("wz-tool").value = `${first.name} ${first.value}`;
    });
  });
  $("wz-generate").addEventListener("click", generate);
  $("wz-dl-mod").addEventListener("click", () => generated && needPro("practiceWizard") && download(generated.fileName, generated.module, "text/plain"));
  $("wz-dl-readme").addEventListener("click", () => generated && needPro("practiceWizard") && download("README.md", generated.readme, "text/markdown"));
}

async function init(): Promise<void> {
  wire();
  let tab: string;
  try {
    tab = localStorage.getItem("mcp-rs-tab") ?? "01";
  } catch {
    tab = "01";
  }
  selectTab(/^0[1-5]$/.test(tab) ? tab : "01");
  await loadPlan().catch((e: unknown) => showError(e instanceof Error ? e.message : String(e)));
  await loadKnowledge().catch(() => undefined);
  await refreshDashboard();
}

void init();
