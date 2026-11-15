/**
 * Offline RAPID checks (Technical reference manual RAPID, 3HAC050946-001 for
 * syntax rules; StorePath/StopMove and CONNECT/IDelete from the RAPID
 * instructions manual). It is a linter, not the controller's compiler: a clean
 * result does not replace loading the module and reading /rw/elog/0.
 */
import {
  inverseKinematics,
  isUnitQuat,
  type Pose,
  quatNorm,
  parsePoseLiteral,
} from "../kinematics/index.js";

export type Severity = "error" | "warning" | "info";

export interface RapidDiagnostic {
  severity: Severity;
  code: string;
  message: string;
  line: number;
  column: number;
}

export interface RobtargetInfo {
  name: string;
  line: number;
  pose: Pose;
  quatNorm: number;
  reach?: { reachable: boolean; joints?: number[]; wristSingular?: boolean; elbowSingular?: boolean };
}

export interface RapidValidationResult {
  ok: boolean;
  moduleName: string | null;
  errors: number;
  warnings: number;
  diagnostics: RapidDiagnostic[];
  robtargets: RobtargetInfo[];
  offsTargets: Array<{ base: string; dx: number; dy: number; dz: number; line: number; reachable?: boolean }>;
}

export interface RapidValidationOptions {
  /** Evaluate reach of CONST/PERS robtargets and numeric Offs() with this tool (default tool0). */
  checkReach?: boolean;
  tool?: Pose;
}

const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const RESERVED = new Set(
  "ALIAS AND BACKWARD CASE CONNECT CONST DEFAULT DIV DO ELSE ELSEIF ENDFOR ENDFUNC ENDIF ENDMODULE ENDPROC ENDRECORD ENDTEST ENDTRAP ENDWHILE ERROR EXIT FALSE FOR FROM FUNC GOTO IF INOUT LOCAL MOD MODULE NOSTEPIN NOT NOVIEW OR PERS PROC RAISE READONLY RECORD RETRY RETURN STEP SYSMODULE TEST THEN TO TRAP TRUE TRYNEXT UNDO VAR VIEWONLY WHILE WITH XOR".split(
    " ",
  ),
);

/** Removes comments and string contents but keeps columns stable. */
function stripLine(line: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) {
      out += ch === '"' ? '"' : " ";
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += '"';
      continue;
    }
    if (ch === "!") break;
    out += ch;
  }
  return out;
}

const BLOCKS: Array<{ open: RegExp; close: RegExp; name: string }> = [
  { name: "MODULE", open: /^\s*MODULE\b/i, close: /^\s*ENDMODULE\b/i },
  { name: "PROC", open: /^\s*(?:LOCAL\s+)?PROC\b/i, close: /^\s*ENDPROC\b/i },
  { name: "FUNC", open: /^\s*(?:LOCAL\s+)?FUNC\b/i, close: /^\s*ENDFUNC\b/i },
  { name: "TRAP", open: /^\s*(?:LOCAL\s+)?TRAP\b/i, close: /^\s*ENDTRAP\b/i },
  { name: "RECORD", open: /^\s*(?:LOCAL\s+)?RECORD\b/i, close: /^\s*ENDRECORD\b/i },
  // Block IF only (single-line IF has no THEN at end of line)
  { name: "IF", open: /^\s*IF\b.*\bTHEN\s*$/i, close: /^\s*ENDIF\b/i },
  { name: "FOR", open: /^\s*FOR\b.*\bDO\s*$/i, close: /^\s*ENDFOR\b/i },
  { name: "WHILE", open: /^\s*WHILE\b.*\bDO\s*$/i, close: /^\s*ENDWHILE\b/i },
  { name: "TEST", open: /^\s*TEST\b/i, close: /^\s*ENDTEST\b/i },
];

export function validateRapidModule(source: string, opts: RapidValidationOptions = {}): RapidValidationResult {
  const diagnostics: RapidDiagnostic[] = [];
  const add = (severity: Severity, code: string, message: string, line: number, column = 1) =>
    diagnostics.push({ severity, code, message, line, column });

  const rawLines = source.replace(/\r\n?/g, "\n").split("\n");
  const lines = rawLines.map(stripLine);
  const stack: Array<{ name: string; line: number }> = [];
  let moduleName: string | null = null;
  let currentRoutine: { name: string; line: number; stopMoveSeen: boolean } | null = null;
  const connects: number[] = [];
  let ideleteSeen = false;
  const robtargets: RobtargetInfo[] = [];
  const offsTargets: RapidValidationResult["offsTargets"] = [];

  lines.forEach((ln, idx) => {
    const lineNo = idx + 1;
    const raw = rawLines[idx]!;
    if (/"/.test(ln) && (raw.split('"').length - 1) % 2 !== 0) {
      add("error", "UNTERMINATED_STRING", "unterminated string literal", lineNo, raw.indexOf('"') + 1);
    }
    if (!ln.trim()) return;

    // Block open/close
    for (const b of BLOCKS) {
      if (b.close.test(ln)) {
        const top = stack[stack.length - 1];
        if (!top) {
          add("error", "UNEXPECTED_END", `END${b.name} without ${b.name}`, lineNo);
        } else if (top.name !== b.name) {
          add("error", "BLOCK_MISMATCH", `END${b.name} closes ${top.name} opened at line ${top.line}`, lineNo);
          stack.pop();
        } else {
          stack.pop();
        }
        if (b.name === "PROC" || b.name === "TRAP" || b.name === "FUNC") currentRoutine = null;
        break;
      }
      if (b.open.test(ln)) {
        if (b.name === "MODULE") {
          const m = /^\s*MODULE\s+([^\s(]+)/i.exec(ln);
          moduleName = m?.[1] ?? null;
          if (stack.length > 0) add("error", "NESTED_MODULE", "MODULE inside another block", lineNo);
          if (!m || !IDENT.test(m[1]!)) add("error", "INVALID_IDENTIFIER", `invalid module name "${m?.[1] ?? ""}"`, lineNo);
        }
        if (b.name === "PROC" || b.name === "TRAP" || b.name === "FUNC") {
          const m = b.name === "FUNC"
            ? /^\s*(?:LOCAL\s+)?FUNC\s+\w+\s+([^\s(]+)/i.exec(ln)
            : new RegExp(`^\\s*(?:LOCAL\\s+)?${b.name}\\s+([^\\s(]+)`, "i").exec(ln);
          const name = m?.[1] ?? "";
          if (!IDENT.test(name) || RESERVED.has(name.toUpperCase())) {
            add("error", "INVALID_IDENTIFIER", `invalid ${b.name} name "${name}"`, lineNo, ln.indexOf(name) + 1);
          }
          if (stack.some((s) => s.name === "PROC" || s.name === "TRAP" || s.name === "FUNC")) {
            add("error", "NESTED_ROUTINE", `${b.name} ${name} opened inside another routine`, lineNo);
          }
          currentRoutine = { name, line: lineNo, stopMoveSeen: false };
        }
        stack.push({ name: b.name, line: lineNo });
        break;
      }
    }

    // Data declarations
    const decl = /^\s*(?:LOCAL\s+|TASK\s+)?(VAR|PERS|CONST)\s+(\w+)\s+([^\s:{;=]+)/i.exec(ln);
    if (decl) {
      const name = decl[3]!;
      if (!IDENT.test(name) || RESERVED.has(name.toUpperCase())) {
        add("error", "INVALID_IDENTIFIER", `invalid identifier "${name}" (letters, digits, _; max 32; no "-")`, lineNo, ln.indexOf(name) + 1);
      }
      if (!/;\s*$/.test(ln)) add("error", "MISSING_SEMICOLON", `declaration of ${name} does not end with ";"`, lineNo);
      const type = decl[2]!.toLowerCase();
      if ((type === "robtarget" || type === "pose" || type === "orient") && /:=/.test(ln)) {
        try {
          const literal = ln.slice(ln.indexOf(":=") + 2);
          const pose =
            type === "orient"
              ? { trans: [0, 0, 0] as [number, number, number], rot: parsePoseLiteral(`[[0,0,0],${literal}]`).rot }
              : parsePoseLiteral(literal);
          const n = quatNorm(pose.rot);
          if (!isUnitQuat(pose.rot)) {
            add("error", "QUATERNION_NOT_NORMALIZED", `${name}: |q| = ${n.toFixed(6)} (use NOrient or fix the literal)`, lineNo);
          }
          // PERS placeholders like [[0,0,0],[1,0,0,0],...] are runtime witnesses, not targets.
          const placeholder = decl[1]!.toUpperCase() !== "CONST" && pose.trans.every((x) => x === 0);
          if (type === "robtarget" && !placeholder) robtargets.push({ name, line: lineNo, pose, quatNorm: n });
        } catch {
          add("warning", "UNPARSED_LITERAL", `${name}: could not parse ${type} literal`, lineNo);
        }
      }
    }

    // Statement checks inside routines
    if (/\bStopMove\b/i.test(ln) && currentRoutine) currentRoutine.stopMoveSeen = true;
    if (/\bStorePath\b/i.test(ln) && currentRoutine && !currentRoutine.stopMoveSeen) {
      add("warning", "STOREPATH_WITHOUT_STOPMOVE", `StorePath in ${currentRoutine.name} without a previous StopMove`, lineNo, ln.search(/StorePath/i) + 1);
    }
    if (/\bCONNECT\b/i.test(ln)) connects.push(lineNo);
    if (/\bIDelete\b/i.test(ln)) ideleteSeen = true;

    const offsRe = /Offs\s*\(\s*(\w+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/gi;
    let om: RegExpExecArray | null;
    while ((om = offsRe.exec(ln)) !== null) {
      offsTargets.push({ base: om[1]!, dx: Number(om[2]), dy: Number(om[3]), dz: Number(om[4]), line: lineNo });
    }
    // Identifiers containing "-" used like names (e.g. "p-home") inside statements
    const dash = /\b([A-Za-z]\w*)-([A-Za-z]\w*)\b/.exec(ln);
    if (dash && !/:=/.test(ln) && /^\s*(?:Move|Set|Reset|WaitDI|PulseDO)\w*/i.test(ln)) {
      add("error", "INVALID_IDENTIFIER", `"${dash[0]}" is not a valid identifier ("-" is the minus operator)`, lineNo, ln.indexOf(dash[0]) + 1);
    }
  });

  for (const open of stack) {
    add("error", "UNCLOSED_BLOCK", `${open.name} opened at line ${open.line} is never closed`, open.line);
  }
  if (!moduleName) add("error", "NO_MODULE", "no MODULE declaration found", 1);
  for (const l of connects) {
    if (!ideleteSeen) add("warning", "CONNECT_WITHOUT_IDELETE", "CONNECT without IDelete: the interrupt number leaks on restart", l);
  }

  if (opts.checkReach) {
    for (const rt of robtargets) {
      if (!isUnitQuat(rt.pose.rot)) continue;
      const ik = inverseKinematics(rt.pose, { tool: opts.tool });
      rt.reach = {
        reachable: ik.reachable,
        ...(ik.joints ? { joints: ik.joints.map((v) => Math.round(v * 1000) / 1000) } : {}),
        wristSingular: ik.check?.wrist.singular,
        elbowSingular: ik.check?.elbow.singular,
      };
      if (!ik.reachable) add("error", "UNREACHABLE", `${rt.name} is not reachable by the IRB 120 with the given tool`, rt.line);
      else if (ik.check?.wrist.singular) add("warning", "WRIST_SINGULARITY", `${rt.name}: |q5| < 3 deg`, rt.line);
    }
    for (const o of offsTargets) {
      const base = robtargets.find((r) => r.name.toLowerCase() === o.base.toLowerCase());
      if (!base || !isUnitQuat(base.pose.rot)) continue;
      const p: Pose = { trans: [base.pose.trans[0] + o.dx, base.pose.trans[1] + o.dy, base.pose.trans[2] + o.dz], rot: base.pose.rot };
      o.reachable = inverseKinematics(p, { tool: opts.tool }).reachable;
      if (!o.reachable) add("error", "OFFS_UNREACHABLE", `Offs(${o.base},${o.dx},${o.dy},${o.dz}) is not reachable`, o.line);
    }
  }

  diagnostics.sort((a, b) => a.line - b.line);
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return {
    ok: errors === 0,
    moduleName,
    errors,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
    diagnostics,
    robtargets,
    offsTargets,
  };
}
