/**
 * Practice generator: from the brief parameters to a complete RAPID module with
 * PERS witness variables plus a delivery README with a verification table to
 * fill in live. The output is validated offline (syntax + reach) before it is
 * returned; nothing is loaded into the controller here.
 */
import { inverseKinematics, nOrient, orientZYX, type Pose, type Quat } from "../kinematics/index.js";
import { type RapidValidationResult, validateRapidModule } from "../rapid/validator.js";

export type PracticeBlock = "trayectorias" | "saltos" | "offs" | "pickplace";

export interface PracticePoint {
  name: string;
  xyz: [number, number, number];
  /** quaternion; defaults to tool pointing down [0,0,1,0] */
  quat?: Quat;
  /** alternative: Euler ZYX (deg) */
  euler?: [number, number, number];
}

export interface PracticeSpec {
  block: PracticeBlock;
  moduleName: string;
  title?: string;
  tool?: { name: string; pose: Pose };
  wobj?: string;
  points: PracticePoint[];
  /** approach / retract height for Offs, mm */
  approachMm?: number;
  speed?: string;
  zone?: string;
  /** DI used to choose a branch (saltos) or trigger the interrupt (pickplace) */
  inputSignal?: string;
  /** second DI for a second branch (saltos) */
  inputSignal2?: string;
  /** DO driving the gripper (pickplace) */
  gripperSignal?: string;
  /** grid for offs: rows x cols with pitch */
  grid?: { rows: number; cols: number; pitchMm: number };
  behavior?: "practica" | "final";
  /** signals present in the live controller (EIO audit); missing ones are reported */
  availableSignals?: string[];
}

export interface PracticeResult {
  fileName: string;
  module: string;
  readme: string;
  validation: RapidValidationResult;
  reach: Array<{ point: string; reachable: boolean; joints?: number[] }>;
  missingSignals: string[];
  witnesses: string[];
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6);
}

function quatOf(p: PracticePoint): Quat {
  if (p.quat) return nOrient(p.quat);
  if (p.euler) return orientZYX(p.euler[0], p.euler[1], p.euler[2]);
  return [0, 0, 1, 0];
}

function robtarget(p: PracticePoint): string {
  const q = quatOf(p);
  return `[[${p.xyz.map(fmt).join(",")}],[${q.map(fmt).join(",")}],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]`;
}

export function generatePractice(spec: PracticeSpec): PracticeResult {
  if (!IDENT.test(spec.moduleName)) throw new Error(`invalid module name ${spec.moduleName}`);
  if (spec.points.length === 0) throw new Error("at least one point is required");
  for (const p of spec.points) if (!IDENT.test(p.name)) throw new Error(`invalid point name ${p.name}`);

  const tool = spec.tool?.name ?? "tool0";
  const wobj = spec.wobj ?? "wobj0";
  const v = spec.speed ?? "v200";
  const z = spec.zone ?? "fine";
  const up = spec.approachMm ?? 50;
  const td = `${tool}\\WObj:=${wobj}`;
  const final = spec.behavior === "final";
  const witnesses: string[] = [];
  const L: string[] = [];
  const decl: string[] = [];
  const pts = spec.points;

  L.push(`MODULE ${spec.moduleName}`);
  L.push(`    ! ${spec.title ?? `Practica generada: bloque ${spec.block}`}`);
  L.push(`    ! Herramienta ${tool}, objeto de trabajo ${wobj}. Generado por mcp-robotstudio (revisar antes de cargar).`);
  for (const p of pts) decl.push(`    CONST robtarget ${p.name}:=${robtarget(p)};`);
  decl.push(`    CONST num ALTO:=${fmt(up)};`);
  const w = (name: string, type = "num", init = "0") => {
    witnesses.push(name);
    decl.push(`    PERS ${type} ${name}:=${init};`);
  };

  const body: string[] = [];
  switch (spec.block) {
    case "trayectorias": {
      w("nVueltas");
      w("nPuntoActual");
      body.push("    PROC main()", "        nPuntoActual:=0;");
      body.push(final ? "        WHILE TRUE DO" : "        FOR i FROM 1 TO 1 DO");
      body.push(`            MoveJ Offs(${pts[0]!.name},0,0,ALTO),${v},${z},${td};`);
      pts.forEach((p, i) => {
        body.push(`            MoveL ${p.name},${v},${z},${td};`, `            nPuntoActual:=${i + 1};`);
      });
      body.push(`            MoveL ${pts[0]!.name},${v},${z},${td};`);
      body.push(`            MoveL Offs(${pts[0]!.name},0,0,ALTO),${v},${z},${td};`);
      body.push("            Incr nVueltas;");
      body.push(final ? "        ENDWHILE" : "        ENDFOR", "    ENDPROC");
      break;
    }
    case "saltos": {
      const di = spec.inputSignal ?? "CAMINO1";
      const di2 = spec.inputSignal2 ?? "CAMINO2";
      if (pts.length < 2) throw new Error("saltos needs at least 2 points (one per branch)");
      w("nCamino1");
      w("nCamino2");
      w("nUltimoCamino");
      body.push("    PROC main()");
      body.push(final ? "        WHILE TRUE DO" : "        FOR i FROM 1 TO 1 DO");
      body.push(`            IF ${di}=1 THEN`, "                camino1;", `            ELSEIF ${di2}=1 THEN`, "                camino2;", "            ELSE", "                WaitTime 0.2;", "            ENDIF");
      body.push(final ? "        ENDWHILE" : "        ENDFOR", "    ENDPROC", "");
      for (const [k, p] of [[1, pts[0]!], [2, pts[1]!]] as Array<[number, PracticePoint]>) {
        body.push(`    PROC camino${k}()`);
        body.push(`        MoveJ Offs(${p.name},0,0,ALTO),${v},${z},${td};`, `        MoveL ${p.name},${v},${z},${td};`, `        MoveL Offs(${p.name},0,0,ALTO),${v},${z},${td};`);
        body.push(`        Incr nCamino${k};`, `        nUltimoCamino:=${k};`, "    ENDPROC", "");
      }
      break;
    }
    case "offs": {
      const g = spec.grid ?? { rows: 3, cols: 3, pitchMm: 40 };
      decl.push(`    CONST num PASO:=${fmt(g.pitchMm)};`);
      w("nCeldas");
      body.push("    PROC main()", "        nCeldas:=0;");
      body.push(`        FOR f FROM 0 TO ${g.rows - 1} DO`, `            FOR c FROM 0 TO ${g.cols - 1} DO`);
      body.push(`                MoveJ Offs(${pts[0]!.name},c*PASO,f*PASO,ALTO),${v},${z},${td};`);
      body.push(`                MoveL Offs(${pts[0]!.name},c*PASO,f*PASO,0),v100,fine,${td};`);
      body.push(`                MoveL Offs(${pts[0]!.name},c*PASO,f*PASO,ALTO),${v},${z},${td};`);
      body.push("                Incr nCeldas;", "            ENDFOR", "        ENDFOR", "    ENDPROC");
      break;
    }
    case "pickplace": {
      if (pts.length < 2) throw new Error("pickplace needs a pick and a place point");
      const di = spec.inputSignal ?? "INTERRUPCION";
      const doG = spec.gripperSignal;
      w("nPiezas");
      w("nInterrupciones");
      w("pParada", "robtarget", "[[0,0,0],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]");
      w("pVuelta", "robtarget", "[[0,0,0],[1,0,0,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]");
      decl.push("    VAR intnum irParada;");
      const [pick, place] = [pts[0]!, pts[1]!];
      body.push("    PROC main()");
      body.push("        IDelete irParada;", `        CONNECT irParada WITH tr_parada;`, `        ISignalDI ${di},1,irParada;`);
      body.push(final ? "        WHILE TRUE DO" : "        FOR i FROM 1 TO 1 DO");
      body.push(`            MoveJ Offs(${pick.name},0,0,ALTO),${v},${z},${td};`, `            MoveL ${pick.name},v100,fine,${td};`);
      if (doG) body.push(`            SetDO ${doG},1;`, "            WaitTime 0.3;");
      body.push(`            MoveL Offs(${pick.name},0,0,ALTO),${v},${z},${td};`);
      body.push(`            MoveJ Offs(${place.name},0,0,ALTO),${v},${z},${td};`, `            MoveL ${place.name},v100,fine,${td};`);
      if (doG) body.push(`            SetDO ${doG},0;`, "            WaitTime 0.3;");
      body.push(`            MoveL Offs(${place.name},0,0,ALTO),${v},${z},${td};`, "            Incr nPiezas;");
      body.push(final ? "        ENDWHILE" : "        ENDFOR", "        IDelete irParada;", "    ENDPROC", "");
      body.push("    TRAP tr_parada", "        StopMove;", "        StorePath;", `        pParada:=CRobT(\\Tool:=${tool}\\WObj:=${wobj});`);
      body.push(`        MoveL Offs(pParada,0,0,ALTO),v100,fine,${td};`, "        WaitTime 1;");
      body.push(`        MoveL pParada,v100,fine,${td};`, `        pVuelta:=CRobT(\\Tool:=${tool}\\WObj:=${wobj});`);
      body.push("        Incr nInterrupciones;", "        RestoPath;", "        StartMove;", "    ENDTRAP");
      break;
    }
  }

  const module = [...L, ...decl, "", ...body, "ENDMODULE", ""].join("\n");
  const validation = validateRapidModule(module, { checkReach: true, tool: spec.tool?.pose });
  const reach = pts.map((p) => {
    const ik = inverseKinematics({ trans: p.xyz, rot: quatOf(p) }, { tool: spec.tool?.pose });
    return { point: p.name, reachable: ik.reachable, ...(ik.joints ? { joints: ik.joints.map((x) => Math.round(x * 100) / 100) } : {}) };
  });
  const needed = [spec.inputSignal, spec.inputSignal2, spec.gripperSignal].filter((s): s is string => Boolean(s));
  if (spec.block === "saltos") needed.push(...[spec.inputSignal ?? "CAMINO1", spec.inputSignal2 ?? "CAMINO2"]);
  if (spec.block === "pickplace" && !spec.inputSignal) needed.push("INTERRUPCION");
  const missingSignals = spec.availableSignals
    ? Array.from(new Set(needed)).filter((s) => !spec.availableSignals!.some((a) => a.toLowerCase() === s.toLowerCase()))
    : [];

  const readme = practiceReadme(spec, module, validation, reach, missingSignals, witnesses);
  return { fileName: `${spec.moduleName}.mod`, module, readme, validation, reach, missingSignals, witnesses };
}

function practiceReadme(
  spec: PracticeSpec,
  _module: string,
  validation: RapidValidationResult,
  reach: PracticeResult["reach"],
  missing: string[],
  witnesses: string[],
): string {
  const rows = [
    ["Modulo cargado", `GET /rw/rapid/modules?task=T_ROB1 contiene ${spec.moduleName}`],
    ["Sin errores de carga", "GET /rw/elog/0 sin 40520 / Load error tras loadmod"],
    ...witnesses.map((w) => [`Testigo ${w}`, `GET /rw/rapid/symbol/data/RAPID/T_ROB1/${spec.moduleName}/${w}`]),
    ...reach.map((r) => [`Alcance ${r.point}`, r.reachable ? `IK offline: [${r.joints?.join(", ")}]` : "NO alcanzable: corregir antes de cargar"]),
  ];
  return [
    `# ${spec.title ?? spec.moduleName}`,
    "",
    `Bloque: **${spec.block}** · comportamiento: **${spec.behavior ?? "practica"}** · herramienta: \`${spec.tool?.name ?? "tool0"}\` · wobj: \`${spec.wobj ?? "wobj0"}\``,
    "",
    "## Validacion offline",
    "",
    `- Errores: ${validation.errors} · avisos: ${validation.warnings}`,
    ...validation.diagnostics.map((d) => `- ${d.severity} ${d.code} (linea ${d.line}): ${d.message}`),
    ...(missing.length ? [`- Senales que faltan en el controlador vivo: ${missing.join(", ")}`] : []),
    "",
    "## Tabla de verificacion (rellenar en vivo)",
    "",
    "| Objetivo | Comprobacion | Evidencia | Verificado |",
    "|---|---|---|---|",
    ...rows.map(([o, c]) => `| ${o} | ${c} | | no |`),
    "",
    "Regla: cada fila se marca `si` solo con la salida literal del comando pegada en *Evidencia*.",
    "",
  ].join("\n");
}
