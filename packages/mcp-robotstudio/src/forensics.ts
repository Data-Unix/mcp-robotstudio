/**
 * Forensic black box: one snapshot of everything needed to explain a stop.
 * All reads run against the controller in parallel right after the call; the
 * module snippet comes from readModuleSource (save to TEMP + delete).
 */
import type { ProgramPointerResult, RwsReadOnlyClient } from "./rws/client.js";
import type { EventLogEntry, IoSignalInfo, JointTargetInfo, PanelState, RobTargetInfo } from "./rws/parsers.js";

export interface KnownIncident {
  id: string;
  match: (s: ForensicSnapshot) => boolean;
  diagnosis: string;
  reference: string;
}

export interface ForensicSnapshot {
  capturedAt: string;
  baseUrl: string;
  dialect: string;
  panel: PanelState | null;
  speedRatio: number | null;
  pcp: ProgramPointerResult | null;
  codeSnippet: { module: string; fromLine: number; lines: string[]; pointerLine: number } | null;
  signals: IoSignalInfo[];
  events: EventLogEntry[];
  joints: JointTargetInfo | null;
  tcp: RobTargetInfo | null;
  errors: string[];
}

export interface ForensicReport extends ForensicSnapshot {
  diagnosis: Array<{ id: string; diagnosis: string; reference: string }>;
  markdown: string;
}

const PP_NOT_SET = "-1073442809";

export const KNOWN_INCIDENTS: KnownIncident[] = [
  {
    id: "pp-not-set",
    match: (s) => s.pcp?.programPointer.errorCode === PP_NOT_SET,
    diagnosis: "Program pointer not set (SYS_CTRL_E_EXEC_STATE): run 'PP to Main' before starting.",
    reference: "RW6 /rw/retcode?code=-1073442809",
  },
  {
    id: "speed-below-100-auto",
    match: (s) => s.panel?.opmode === "AUTO" && s.speedRatio !== null && s.speedRatio < 100,
    diagnosis: "Speed ratio below 100 % in AUTO: cycle time grows by 100/ratio.",
    reference: "/rw/panel/speedratio",
  },
  {
    id: "loadmod-204-with-errors",
    match: (s) => s.events.some((e) => e.code === "40520" || e.title === "Load error" || /syntax/i.test(e.desc)),
    diagnosis: "A module load failed although loadmod answered 204: fix the syntax and check /rw/rapid/modules.",
    reference: "incident 2026-11-14-loadmod-204-con-errores",
  },
  {
    id: "too-many-sessions",
    match: (s) => s.errors.some((e) => /too many sessions/i.test(e)),
    diagnosis: "RWS session limit reached (70): reuse the session cookie instead of re-authenticating.",
    reference: "incident 2026-11-14-too-many-sessions",
  },
  {
    id: "guard-stop",
    match: (s) => s.panel?.ctrlstate === "guardstop" || s.panel?.ctrlstate === "emergencystop",
    diagnosis: "Controller in protective/emergency stop: motors off, the program cannot continue.",
    reference: "/rw/panel/ctrlstate",
  },
  {
    id: "unreachable-target",
    match: (s) => s.events.some((e) => /out of reach|outside reach|50050|50028/i.test(`${e.code} ${e.title} ${e.desc}`)),
    diagnosis: "Target outside reach or joint limit: probe it offline (probe_reach_kinematics) and tilt the tool.",
    reference: "incident 2026-11-14-alcance-irb120-orientacion",
  },
  {
    id: "di-not-writable",
    match: (s) => s.errors.some((e) => /-1073445881/.test(e)),
    diagnosis: "Digital input without device cannot be written over RWS: use the I/O simulator.",
    reference: "incident 2026-11-14-di-no-escribible-por-rws",
  },
];

async function safe<T>(errors: string[], label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function captureForensicBlackbox(
  client: RwsReadOnlyClient,
  opts: { task?: string; contextLines?: number; signalFilter?: string; includeCode?: boolean } = {},
): Promise<ForensicReport> {
  const errors: string[] = [];
  const task = opts.task ?? client.task;
  const [panel, speed, pcp, signals, elog, joints, tcp] = await Promise.all([
    safe(errors, "panel", () => client.getPanelState()),
    safe(errors, "speedratio", () => client.getSpeedRatio()),
    safe(errors, "pcp", () => client.getProgramPointer(task)),
    safe(errors, "signals", () => client.listSignals(opts.signalFilter ?? "", 64)),
    safe(errors, "elog", () => client.getEventLog(10, 0)),
    safe(errors, "joints", () => client.getJoints()),
    safe(errors, "tcp", () => client.getTcp()),
  ]);

  let codeSnippet: ForensicSnapshot["codeSnippet"] = null;
  const pp = pcp?.programPointer;
  if ((opts.includeCode ?? true) && pp?.module && pp.beginLine) {
    const src = await safe(errors, "module source", () => client.readModuleSource(pp.module!, task));
    if (src) {
      const all = src.source.replace(/\r\n?/g, "\n").split("\n");
      const ctx = opts.contextLines ?? 5;
      const from = Math.max(1, pp.beginLine - ctx);
      codeSnippet = {
        module: pp.module,
        fromLine: from,
        pointerLine: pp.beginLine,
        lines: all.slice(from - 1, pp.beginLine + ctx),
      };
    }
  }

  const snap: ForensicSnapshot = {
    capturedAt: new Date().toISOString(),
    baseUrl: client.baseUrl,
    dialect: client.dialect,
    panel,
    speedRatio: speed?.speedRatio ?? null,
    pcp,
    codeSnippet,
    signals: signals?.signals ?? [],
    events: elog?.events ?? [],
    joints,
    tcp,
    errors,
  };
  const diagnosis = KNOWN_INCIDENTS.filter((k) => k.match(snap)).map(({ id, diagnosis: d, reference }) => ({ id, diagnosis: d, reference }));
  return { ...snap, diagnosis, markdown: forensicMarkdown(snap, diagnosis) };
}

export function forensicMarkdown(s: ForensicSnapshot, diagnosis: Array<{ id: string; diagnosis: string; reference: string }>): string {
  const pp = s.pcp?.programPointer;
  const out = [
    `# Informe forense ${s.capturedAt}`,
    "",
    `| Campo | Valor |`,
    `|---|---|`,
    `| Controlador | ${s.baseUrl} (${s.dialect}) |`,
    `| Motores / modo | ${s.panel?.ctrlstate ?? "-"} / ${s.panel?.opmode ?? "-"} |`,
    `| Ejecucion | ${s.panel?.ctrlexecstate ?? "-"} (${s.panel?.cycle ?? "-"}) |`,
    `| SpeedRatio | ${s.speedRatio ?? "-"} % |`,
    `| PP | ${pp?.module ? `${pp.module}/${pp.routine} linea ${pp.beginLine}:${pp.beginColumn}` : `no disponible (${pp?.errorCode ?? "sin dato"})`} |`,
    `| Joints | ${s.joints?.jointsDeg.map((v) => v.toFixed(2)).join(", ") ?? "-"} |`,
    `| TCP | ${s.tcp ? `[${s.tcp.x}, ${s.tcp.y}, ${s.tcp.z}] q=[${s.tcp.q1}, ${s.tcp.q2}, ${s.tcp.q3}, ${s.tcp.q4}]` : "-"} |`,
    "",
  ];
  if (s.codeSnippet) {
    out.push(`## Codigo alrededor del PP (${s.codeSnippet.module})`, "", "```rapid");
    s.codeSnippet.lines.forEach((l, i) => {
      const n = s.codeSnippet!.fromLine + i;
      out.push(`${n === s.codeSnippet!.pointerLine ? ">" : " "}${String(n).padStart(4)} ${l}`);
    });
    out.push("```", "");
  }
  out.push("## Eventos (/rw/elog/0)", "", "| Codigo | Tipo | Hora | Titulo |", "|---|---|---|---|");
  for (const e of s.events) out.push(`| ${e.code ?? ""} | ${e.type ?? ""} | ${e.time ?? ""} | ${(e.title ?? "").replace(/\|/g, "/")} |`);
  out.push("", "## Diagnostico cruzado", "");
  if (diagnosis.length === 0) out.push("Sin coincidencias con incidentes conocidos.");
  for (const d of diagnosis) out.push(`- **${d.id}**: ${d.diagnosis} (${d.reference})`);
  if (s.errors.length) out.push("", "## Lecturas fallidas", "", ...s.errors.map((e) => `- ${e}`));
  return out.join("\n");
}
