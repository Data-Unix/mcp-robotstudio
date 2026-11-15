import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { captureForensicBlackbox } from "../src/forensics.js";
import {
  checkJoints,
  eulerZYX,
  forwardKinematics,
  inverseKinematics,
  IRB120_ELBOW_STRETCH_Q3,
  isUnitQuat,
  type Joints,
  manipulability,
  nOrient,
  orientZYX,
  poseInv,
  poseMult,
  relTool,
} from "../src/kinematics/index.js";
import { generatePractice, type PracticeBlock } from "../src/practice/generator.js";
import { diffModules } from "../src/rapid/diff.js";
import { validateRapidModule } from "../src/rapid/validator.js";
import { checkRecipeWrite } from "../src/recipes.js";
import { RwsClient } from "../src/rws/index.js";
import { FakeRwsServer } from "../src/testing/fake-rws-server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FINAL_MOD = path.join(ROOT, "practicas/6.3-colisiones-interrupciones/rapid/Practica63_Final.mod");
// practicas/ is not part of the public export: tests on the real module skip there.
const HAS_PRACTICAS = fs.existsSync(FINAL_MOD);
const MYTOOL = { trans: [31.792631019, 0, 229.638935148] as [number, number, number], rot: [0.945518576, 0, 0.325568154, 0] as [number, number, number, number] };

const close = (a: number[], b: number[], tol = 1e-3) => a.forEach((v, i) => expect(Math.abs(v - b[i]!)).toBeLessThan(tol));

describe("IRB 120 kinematics", () => {
  it("forward kinematics matches the live RW 6.16 controller", () => {
    const z = forwardKinematics([0, 0, 0, 0, 0, 0]);
    close(z.trans, [374, 0, 630]);
    close(z.rot, [Math.SQRT1_2, 0, Math.SQRT1_2, 0]);
    // live: joints [0,0,0,0,30,0] -> robtarget [364.3538, 0, 594.0001] q [0.5, 0, 0.8660254, 0]
    const j5 = forwardKinematics([0, 0, 0, 0, 30, 0]);
    close(j5.trans, [364.3538, 0, 594.0001], 1e-3);
    close(j5.rot, [0.5, 0, 0.8660254, 0], 1e-6);
  });

  it("inverse kinematics round-trips random poses inside the limits", () => {
    const samples: Joints[] = [
      [20, 15, -10, 30, 40, -20],
      [-60, 30, 20, -45, 70, 90],
      [100, -40, 40, 10, -50, -120],
    ];
    for (const q of samples) {
      const p = forwardKinematics(q);
      const ik = inverseKinematics(p);
      expect(ik.reachable).toBe(true);
      expect(ik.positionErrorMm).toBeLessThan(0.05);
      const back = forwardKinematics(ik.joints!);
      close(back.trans, p.trans, 0.05);
    }
  });

  it("reaches the Practica63_Final targets with MyTool and flags points beyond reach", () => {
    expect(inverseKinematics({ trans: [340, 90, 205], rot: [0, 0, 1, 0] }, { tool: MYTOOL }).reachable).toBe(true);
    expect(inverseKinematics({ trans: [315, -185, 255], rot: [0, 0, 1, 0] }, { tool: MYTOOL }).reachable).toBe(true);
    expect(inverseKinematics({ trans: [1200, 0, 300], rot: [0, 0, 1, 0] }, { tool: MYTOOL }).reachable).toBe(false);
    expect(inverseKinematics({ trans: [300, 0, 300], rot: [0, 0, 2, 0] }).reachable).toBe(false); // non-unit
  });

  it("OrientZYX / EulerZYX / NOrient / PoseMult / PoseInv / RelTool", () => {
    const q = orientZYX(30, -20, 10);
    expect(isUnitQuat(q)).toBe(true);
    const e = eulerZYX(q);
    close([e.z, e.y, e.x], [30, -20, 10], 1e-9);
    close(orientZYX(0, 90, 0), [Math.SQRT1_2, 0, Math.SQRT1_2, 0], 1e-9);
    close(nOrient([0, 0, 2, 0]), [0, 0, 1, 0]);
    const a = { trans: [100, 20, -5] as [number, number, number], rot: orientZYX(45, 0, 0) };
    const id = poseMult(a, poseInv(a));
    close(id.trans, [0, 0, 0], 1e-9);
    close(id.rot, [1, 0, 0, 0], 1e-9);
    // RelTool along tool Z of a downward tool moves world -Z
    const down = { trans: [300, 0, 300] as [number, number, number], rot: [0, 0, 1, 0] as [number, number, number, number] };
    close(relTool(down, 0, 0, 50).trans, [300, 0, 250], 1e-9);
  });

  it("singularities, limits and manipulability", () => {
    const wrist = checkJoints([0, 0, 0, 0, 2, 0]);
    expect(wrist.safe).toBe(false);
    expect(wrist.reason).toMatch(/Wrist singularity/);
    expect(checkJoints([0, 130, 0, 0, 30, 0]).reason).toMatch(/Joint 2 .* exceeds limits \[-110, 110\]/);
    // the IRB 120 elbow offset (70 mm) puts the stretched arm at q3 = -atan2(302,70)
    expect(IRB120_ELBOW_STRETCH_Q3).toBeCloseTo(-76.95, 1);
    const elbow = checkJoints([0, 0, IRB120_ELBOW_STRETCH_Q3 + 1, 0, 30, 0]);
    expect(elbow.elbow.singular).toBe(true);
    expect(elbow.warnings.join(" ")).toMatch(/elbow/);
    expect(manipulability([0, 0, IRB120_ELBOW_STRETCH_Q3, 0, 45, 0])).toBeLessThan(1e-6);
    expect(manipulability([0, 0, 0, 0, 0, 0])).toBeLessThan(1e-6); // q5 = 0
    expect(manipulability([0, 0, 0, 0, 45, 0])).toBeGreaterThan(1e-3);
    expect(checkJoints([0, 0, 0, 0, 45, 0]).safe).toBe(true);
  });
});

describe("recipe anti-collision shield", () => {
  const cur = "[[340,90,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]";
  it("allows a small reachable change", () => {
    const r = checkRecipeWrite("robtarget", cur, "[[350,90,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", { tool: MYTOOL });
    expect(r.allowed).toBe(true);
    expect(r.details.jumpMm).toBeCloseTo(10);
  });
  it("blocks jumps above delta_max, non-unit quaternions and points outside the envelope", () => {
    expect(checkRecipeWrite("robtarget", cur, "[[340,190,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", { deltaMaxMm: 50, tool: MYTOOL }).reasons.join()).toMatch(/delta_max/);
    expect(checkRecipeWrite("robtarget", cur, "[[340,90,205],[0,0,0.9,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]").reasons.join()).toMatch(/quaternion/);
    expect(checkRecipeWrite("robtarget", null, "[[900,0,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]").reasons.join()).toMatch(/envelope/);
    expect(checkRecipeWrite("robtarget", null, "[[20,0,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]").reasons.join()).toMatch(/clearance/);
  });
  it("checks num ranges and jumps", () => {
    expect(checkRecipeWrite("num", "10", "12", { numMin: 0, numMax: 20, deltaMaxMm: 5 }).allowed).toBe(true);
    expect(checkRecipeWrite("num", "10", "30", { numMax: 20 }).allowed).toBe(false);
    expect(checkRecipeWrite("num", "10", "18", { deltaMaxMm: 5 }).allowed).toBe(false);
    expect(checkRecipeWrite("num", "10", "abc").allowed).toBe(false);
  });
});

describe("offline RAPID validator", () => {
  it.skipIf(!HAS_PRACTICAS)("accepts the real Practica63_Final module", () => {
    const r = validateRapidModule(fs.readFileSync(FINAL_MOD, "utf8"), { checkReach: true, tool: MYTOOL });
    expect(r.diagnostics).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.moduleName).toBe("Practica63_Final");
    expect(r.robtargets.map((t) => t.name)).toEqual(["P_MATRIZ", "P_ARRAY"]);
    expect(r.robtargets.every((t) => t.reach?.reachable)).toBe(true);
  });

  const codes = (src: string, reach = false) => validateRapidModule(src, { checkReach: reach }).diagnostics.map((d) => d.code);

  it("detects invalid identifiers, unclosed blocks and END mismatches", () => {
    expect(codes("MODULE M\n  VAR num p-home:=0;\nENDMODULE")).toContain("INVALID_IDENTIFIER");
    expect(codes("MODULE M\n  PROC main()\n    MoveL p-home,v100,fine,tool0;\n  ENDPROC\nENDMODULE")).toContain("INVALID_IDENTIFIER");
    expect(codes("MODULE M\n  PROC main()\n    WaitTime 1;\nENDMODULE")).toEqual(expect.arrayContaining(["BLOCK_MISMATCH"]));
    expect(codes("MODULE M\n  PROC main()\n    WaitTime 1;\n  ENDPROC\n")).toContain("UNCLOSED_BLOCK");
    expect(codes("MODULE M\n  TRAP t\n  ENDTRAP\n  IF a=1 THEN\nENDMODULE")).toContain("BLOCK_MISMATCH");
    expect(codes("  PROC main()\n  ENDPROC")).toContain("NO_MODULE");
    expect(codes('MODULE M\n  VAR string s:="abc;\nENDMODULE')).toContain("UNTERMINATED_STRING");
    expect(codes("MODULE M\n  VAR num x:=1\nENDMODULE")).toContain("MISSING_SEMICOLON");
  });

  it("detects non-normalized quaternions, StorePath without StopMove and CONNECT without IDelete", () => {
    expect(codes("MODULE M\n  CONST robtarget p:=[[300,0,300],[0,0,0.8,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];\nENDMODULE")).toContain("QUATERNION_NOT_NORMALIZED");
    expect(codes("MODULE M\n  TRAP t\n    StorePath;\n    RestoPath;\n  ENDTRAP\nENDMODULE")).toContain("STOREPATH_WITHOUT_STOPMOVE");
    expect(codes("MODULE M\n  TRAP t\n    StopMove;\n    StorePath;\n  ENDTRAP\nENDMODULE")).not.toContain("STOREPATH_WITHOUT_STOPMOVE");
    expect(codes("MODULE M\n  VAR intnum i;\n  PROC main()\n    CONNECT i WITH t;\n  ENDPROC\n  TRAP t\n  ENDTRAP\nENDMODULE")).toContain("CONNECT_WITHOUT_IDELETE");
  });

  it("checks reach of robtargets and numeric Offs", () => {
    const src = "MODULE M\n  CONST robtarget p:=[[300,0,300],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]];\n  PROC main()\n    MoveL Offs(p,0,0,30),v100,fine,tool0;\n    MoveL Offs(p,600,0,0),v100,fine,tool0;\n  ENDPROC\nENDMODULE";
    const r = validateRapidModule(src, { checkReach: true });
    expect(r.offsTargets.map((o) => o.reachable)).toEqual([true, false]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["OFFS_UNREACHABLE"]);
  });
});

describe("Time-Machine diff", () => {
  it("reports identical modules ignoring whitespace and CRLF", () => {
    const d = diffModules("MODULE M\r\n  PROC main()\r\n  ENDPROC\r\nENDMODULE\r\n", "MODULE M\n    PROC main()\n    ENDPROC\nENDMODULE");
    expect(d.identical).toBe(true);
  });
  it("finds the changed line with golden/live line numbers", () => {
    const golden = "MODULE M\n  CONST num A:=1;\n  PROC main()\n  ENDPROC\nENDMODULE";
    const live = "MODULE M\n  CONST num A:=2;\n  PROC main()\n    WaitTime 1;\n  ENDPROC\nENDMODULE";
    const d = diffModules(golden, live);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
    expect(d.lines.find((l) => l.op === "remove")).toMatchObject({ goldenLine: 2, text: "  CONST num A:=1;" });
    expect(d.lines.filter((l) => l.op === "add").map((l) => l.liveLine)).toEqual([2, 4]);
    expect(d.unified).toContain("- " + "  CONST num A:=1;");
  });
});

describe("practice generator", () => {
  for (const block of ["trayectorias", "saltos", "offs", "pickplace"] as PracticeBlock[]) {
    it(`${block}: produces a module that passes the offline validator with reach`, () => {
      const r = generatePractice({
        block,
        moduleName: `Gen_${block}`,
        tool: { name: "MyTool", pose: MYTOOL },
        points: [{ name: "pA", xyz: [340, 90, 205] }, { name: "pB", xyz: [315, -185, 255] }],
        behavior: block === "pickplace" ? "final" : "practica",
        gripperSignal: block === "pickplace" ? "DO_PINZA" : undefined,
        availableSignals: ["CAMINO1", "CAMINO2", "INTERRUPCION"],
      });
      expect(r.validation.diagnostics).toEqual([]);
      expect(r.reach.every((x) => x.reachable)).toBe(true);
      expect(r.witnesses.length).toBeGreaterThan(0);
      for (const w of r.witnesses) expect(r.module).toMatch(new RegExp(`PERS \\w+ ${w}:=`));
      expect(r.readme).toContain("| Objetivo | Comprobacion | Evidencia | Verificado |");
      if (block === "pickplace") {
        expect(r.module).toMatch(/StopMove;\s+StorePath;/);
        expect(r.module).toContain("IDelete irParada;");
        expect(r.missingSignals).toEqual(["DO_PINZA"]);
      }
    });
  }
  it("rejects invalid names", () => {
    expect(() => generatePractice({ block: "offs", moduleName: "bad-name", points: [{ name: "p", xyz: [300, 0, 300] }] })).toThrow(/invalid module/);
  });
});

describe("forensic black box against the fake controller", () => {
  let server: FakeRwsServer | undefined;
  afterEach(async () => server?.stop());

  it.skipIf(!HAS_PRACTICAS)("captures PCP + code snippet + events and cross-checks known incidents", async () => {
    server = new FakeRwsServer();
    const baseUrl = await server.start();
    const src = fs.readFileSync(FINAL_MOD, "utf8");
    server.defineModule("Practica63_Final", src);
    server.pcp = { module: "Practica63_Final", routine: "recorrer_array", line: 52, column: 9 };
    server.opmode = "AUTO";
    server.speedRatio = 50;
    server.addEvent({ code: "40520", msgtype: "3", src: "RAPID", title: "Load error", desc: "syntax error" });
    const rep = await captureForensicBlackbox(new RwsClient({ baseUrl }), { contextLines: 2 });
    expect(rep.pcp?.programPointer.beginLine).toBe(52);
    expect(rep.codeSnippet?.pointerLine).toBe(52);
    expect(rep.codeSnippet?.lines).toHaveLength(5);
    expect(rep.codeSnippet?.lines[2]).toContain("MoveL Offs(pInterrupcion,0,0,SEGURIDAD)");
    expect(rep.speedRatio).toBe(50);
    // the RW 6.16 ctrlstate fixture is "guardstop"
    expect(rep.diagnosis.map((d) => d.id).sort()).toEqual(["guard-stop", "loadmod-204-with-errors", "speed-below-100-auto"]);
    expect(rep.markdown).toContain(">  52");
    expect(server.tempFileNames).toEqual([]);
  });

  it("reports PP not set", async () => {
    server = new FakeRwsServer();
    const rep = await captureForensicBlackbox(new RwsClient({ baseUrl: await server.start() }));
    expect(rep.diagnosis.map((d) => d.id)).toContain("pp-not-set");
    expect(rep.codeSnippet).toBeNull();
  });
});
