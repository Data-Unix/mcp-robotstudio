import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli-args.js";
import { createMcpRobotStudioServer, READ_ONLY_TOOL_NAMES, SCOPED_TOOL_NAMES } from "../src/mcp/server.js";
import { anonymizeRspag, auditRspag, pngChunks } from "../src/rspag/audit.js";
import { nodeCodec } from "../src/rspag/node-codec.js";
import { readZip, writeZip } from "../src/rspag/zip.js";
import { RwsClient } from "../src/rws/index.js";
import { AuditLog, type PermissionScope, verifyAuditLog } from "../src/security.js";
import { FakeRwsServer } from "../src/testing/fake-rws-server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("CLI permission flags", () => {
  it("is read-only by default and maps each flag to one scope", () => {
    expect([...parseCliArgs([], {}).scopes]).toEqual([]);
    expect([...parseCliArgs(["--allow-io-write"], {}).scopes]).toEqual(["io-write"]);
    expect([...parseCliArgs(["--allow-var-write", "--allow-motion"], {}).scopes].sort()).toEqual(["motion", "var-write"]);
    expect([...parseCliArgs(["--allow-write"], {}).scopes].sort()).toEqual(["io-write", "module-upload", "motion", "var-write"]);
    expect(parseCliArgs(["--dialect", "rws2", "--insecure-tls", "--rws-url=https://10.0.0.5"], {})).toMatchObject({ dialect: "rws2", insecureTls: true, rwsUrl: "https://10.0.0.5" });
    expect(() => parseCliArgs(["--dialect", "rws3"], {})).toThrow(/auto, rws1 or rws2/);
    expect(() => parseCliArgs(["--nope"], {})).toThrow(/Unknown/);
  });
});

describe("granular scopes over MCP (in-memory transport)", () => {
  let server: FakeRwsServer;
  let baseUrl: string;
  let logFile: string;
  beforeEach(async () => {
    server = new FakeRwsServer();
    baseUrl = await server.start();
    logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rs-audit-")), "audit.jsonl");
  });
  afterEach(async () => {
    await server.stop();
    fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
  });

  async function connect(scopes: PermissionScope[]) {
    const mcp = createMcpRobotStudioServer({ rwsClient: new RwsClient({ baseUrl }), scopes, auditLog: new AuditLog(logFile, "vitest", "Default User") });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcp.connect(a);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(b);
    return client;
  }

  const cases: Array<[PermissionScope[], string[]]> = [
    [[], []],
    [["io-write"], ["write_io_signal"]],
    [["var-write"], ["write_rapid_symbol"]],
    [["module-upload"], ["load_module", "trigger_controller_backup"]],
    [["motion"], ["reset_pp", "set_speed_ratio", "start_rapid", "stop_rapid"]],
  ];
  for (const [scopes, extra] of cases) {
    it(`scopes [${scopes.join(",") || "read-only"}] expose exactly ${extra.length} mutating tools`, async () => {
      const client = await connect(scopes);
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...READ_ONLY_TOOL_NAMES, ...extra].sort());
      await client.close();
    });
  }

  it("var-write only writes PERS symbols and blocks unsafe recipe values before reaching the controller", async () => {
    server.defineSymbol("T_ROB1/Rec/pPick", "[[340,90,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", "per", "robtarget");
    server.defineSymbol("T_ROB1/Rec/P_FIX", "[[340,90,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", "con", "robtarget");
    const client = await connect(["var-write"]);
    const call = async (args: Record<string, unknown>) =>
      (await client.callTool({ name: "write_rapid_symbol", arguments: { module: "Rec", ...args } })) as { isError?: boolean; structuredContent: Record<string, unknown> };

    const constRes = await call({ symbol: "P_FIX", value: "[[345,90,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]" });
    expect(constRes.isError).toBe(true);
    expect(String(constRes.structuredContent.reason)).toMatch(/only PERS/);

    const jump = await call({ symbol: "pPick", value: "[[340,290,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", deltaMaxMm: 50 });
    expect(jump.isError).toBe(true);
    expect(jump.structuredContent.controllerChanges).toMatch(/blocked/);
    expect(server.requestLog.some((l) => l.includes("pPick?action=set"))).toBe(false);

    const ok = await call({ symbol: "pPick", value: "[[350,90,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", deltaMaxMm: 50 });
    expect(ok.isError).not.toBe(true);
    expect(server.requestLog.some((l) => l.includes("pPick?action=set"))).toBe(true);
    await client.close();
  });

  it("module-upload runs the offline validator first and still catches the controller false 204", async () => {
    const client = await connect(["module-upload"]);
    const offline = (await client.callTool({ name: "load_module", arguments: { fileName: "Bad.mod", content: "MODULE Bad\n  PROC main()\n    WaitTime 1;\nENDMODULE" } })) as { isError?: boolean; structuredContent: Record<string, unknown> };
    expect(offline.isError).toBe(true);
    expect(offline.structuredContent.stage).toBe("offline-validation");
    expect(server.requestLog.some((l) => l.startsWith("PUT /fileservice"))).toBe(false);

    const ctrl = (await client.callTool({ name: "load_module", arguments: { fileName: "Fail.mod", content: "MODULE Fail\n  SYNTAX_ERROR\nENDMODULE" } })) as { isError?: boolean; structuredContent: Record<string, unknown> };
    expect(ctrl.isError).toBe(true);
    expect(ctrl.structuredContent.reason).toMatch(/not present|load errors/);

    const bk = (await client.callTool({ name: "trigger_controller_backup", arguments: { dirName: "bk1" } })) as { structuredContent: Record<string, unknown> };
    expect(bk.structuredContent.backupPath).toBe("$TEMP/bk1");
    await client.close();
  });

  it("motion scope: speed ratio and reset_pp", async () => {
    server.defineModule("Main", "MODULE Main\n  PROC main()\n  ENDPROC\nENDMODULE");
    const client = await connect(["motion"]);
    const sr = (await client.callTool({ name: "set_speed_ratio", arguments: { ratio: 100 } })) as { structuredContent: Record<string, unknown> };
    expect(sr.structuredContent.speedRatio).toBe(100);
    const pp = (await client.callTool({ name: "reset_pp", arguments: {} })) as { structuredContent: { pcp: { programPointer: { routine: string } } } };
    expect(pp.structuredContent.pcp.programPointer.routine).toBe("main");
    await client.close();
  });

  it("writes a hash-chained append-only audit log with redacted secrets and detects tampering", async () => {
    const client = await connect(["io-write"]);
    await client.callTool({ name: "get_speed_ratio", arguments: {} });
    await client.callTool({ name: "write_io_signal", arguments: { name: "DRV1TESTE2", value: 1 } });
    await client.callTool({ name: "write_io_signal", arguments: { name: "CAMINO1", value: 1 } }); // DI without device -> rejected
    await client.close();
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => [l.tool, l.scope, l.outcome])).toEqual([
      ["get_speed_ratio", "read", "ok"],
      ["write_io_signal", "io-write", "ok"],
      ["write_io_signal", "io-write", "error"],
    ]);
    expect(lines[1]).toMatchObject({ agent: "vitest", rwsUser: "Default User", seq: 2 });
    expect(verifyAuditLog(logFile)).toEqual({ ok: true, records: 3 });

    const log = new AuditLog(logFile, "vitest");
    const rec = log.record({ tool: "x", scope: "read", params: { password: "robotics", nested: { token: "t" } }, outcome: "ok", result: {} });
    expect(rec.seq).toBe(4);
    expect(JSON.stringify(rec.params)).not.toContain("robotics");
    expect(verifyAuditLog(logFile).ok).toBe(true);

    const tampered = fs.readFileSync(logFile, "utf8").replace('"outcome":"error"', '"outcome":"ok"');
    fs.writeFileSync(logFile, tampered);
    expect(verifyAuditLog(logFile)).toMatchObject({ ok: false, brokenAt: 3 });
  });
});

describe(".rspag audit and anonymization", () => {
  const enc = new TextEncoder();
  const utf16le = (s: string) => {
    const b = new Uint8Array(2 + s.length * 2);
    b[0] = 0xff;
    b[1] = 0xfe;
    for (let i = 0; i < s.length; i++) {
      b[2 + i * 2] = s.charCodeAt(i) & 0xff;
      b[3 + i * 2] = s.charCodeAt(i) >> 8;
    }
    return b;
  };
  const png = (withText: boolean) => {
    const crcless = (type: string, data: number[]) => [0, 0, 0, data.length, ...enc.encode(type), ...data, 0, 0, 0, 0];
    return new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10,
      ...crcless("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
      ...(withText ? crcless("tEXt", [...enc.encode("Author"), 0, ...enc.encode("Ana")]) : []),
      ...crcless("IDAT", [1, 2, 3]),
      ...crcless("IEND", []),
    ]);
  };
  // Synthetic profile path, assembled so the repo privacy scanner does not see a literal one.
  const USER_DIR = ["C:", "Users", "RealStudent"].join("\\");
  const keyId = new Uint8Array([0xfe, 0x50, 0x05, ...enc.encode("RealStudent"), 0x00, 0xab]);

  async function buildPackage(opts: { badGuid?: boolean; copyProject?: boolean } = {}) {
    const codec = await nodeCodec();
    const base = "Controller Data/IRB120_3_58/";
    return await writeZip(
      [
        { name: "Project30_Final.rsproj", data: new Uint8Array() },
        { name: "Preview.png", data: png(true) },
        { name: `${base}BACKINFO/system.guid`, data: enc.encode(opts.badGuid ? "not-a-guid" : "{7A8BF1E4-734F-4AE3-848F-F8433D77861B}") },
        { name: `${base}BACKINFO/template.guid`, data: enc.encode("{7351C77F-478C-4197-89E4-DB4C9872CE2D}") },
        { name: `${base}BACKINFO/key.id`, data: keyId },
        {
          name: `${base}BACKINFO/rw6system.xml`,
          data: enc.encode(`<system><system-xml path="${USER_DIR}\\Desktop\\Proyectos RobotStudio\\${opts.copyProject ? "Project30 - copia" : "Project30_Final"}\\Virtual Controllers\\IRB120_3_58\\system.xml" /></system>`),
        },
        { name: `${base}system.xml`, data: utf16le(`<Media path="${USER_DIR}\\AppData\\Local\\ABB" /> real.student@example.org`) },
        { name: `${base}HOME/Main.mod`, data: enc.encode("MODULE Main\nENDMODULE\n") },
      ],
      codec,
    );
  }

  it("finds user paths (UTF-8 and UTF-16), e-mails, PNG metadata, and passes guid checks", async () => {
    const codec = await nodeCodec();
    const r = await auditRspag(await buildPackage(), codec);
    expect(r.verdict).toBe("fail");
    expect(r.privacy.map((p) => p.kind).sort()).toEqual(["email", "user-path", "user-path"]);
    expect(r.pngs[0]).toMatchObject({ entry: "Preview.png", metadataChunks: ["tEXt"] });
    expect(r.controllers[0]).toMatchObject({ guidsWellFormed: true, hasHome: true, backupProjectName: "Project30_Final", issues: [] });
  });

  it("flags malformed guids and a backup taken from a folder copy (0x800706BA)", async () => {
    const codec = await nodeCodec();
    const bad = await auditRspag(await buildPackage({ badGuid: true }), codec);
    expect(bad.controllers[0]!.issues.join()).toMatch(/not valid GUIDs/);
    const copy = await auditRspag(await buildPackage({ copyProject: true }), codec);
    expect(copy.issues.join()).toMatch(/0x800706BA/);
  });

  it("anonymizes text entries in their own encoding, strips PNG text chunks and keeps key.id byte-identical", async () => {
    const codec = await nodeCodec();
    const an = await anonymizeRspag(await buildPackage(), codec, { blocklist: ["real.student@example.org"] });
    expect(an.changedEntries.sort()).toEqual([
      "Controller Data/IRB120_3_58/BACKINFO/rw6system.xml",
      "Controller Data/IRB120_3_58/system.xml",
      "Preview.png",
    ]);
    const after = await auditRspag(an.data, codec);
    expect(after.privacy).toEqual([]);
    expect(after.verdict).toBe("ok");
    const entries = readZip(an.data);
    const key = entries.find((e) => e.name.endsWith("key.id"))!;
    expect(Array.from(key.raw.length === keyId.length && key.method === 0 ? key.raw : await codec.inflateRaw(key.raw))).toEqual(Array.from(keyId));
    const sys = entries.find((e) => e.name.endsWith("/system.xml"))!;
    const sysData = await codec.inflateRaw(sys.raw);
    expect([sysData[0], sysData[1]]).toEqual([0xff, 0xfe]); // still UTF-16 LE with BOM
    expect(pngChunks(an.preview!)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  const REAL_RSPAG = path.join(ROOT, "practicas/6.3-colisiones-interrupciones/entregables/Practica63_Final.rspag");
  it.skipIf(!fs.existsSync(REAL_RSPAG))("audits the real delivered Practica63_Final.rspag as clean and repacks it byte-identically", async () => {
    const codec = await nodeCodec();
    const file = REAL_RSPAG;
    const buf = new Uint8Array(fs.readFileSync(file));
    const r = await auditRspag(buf, codec);
    expect(r.verdict).toBe("ok");
    expect(r.controllers[0]).toMatchObject({ name: "IRB120_3_58", guidsWellFormed: true });
    const an = await anonymizeRspag(buf, codec);
    expect(an.changedEntries).toEqual([]);
    expect(an.data.length).toBe(buf.length);
  });
});

describe("tool name inventory", () => {
  it("every scoped tool belongs to exactly one scope", () => {
    const all = Object.values(SCOPED_TOOL_NAMES).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.some((n) => (READ_ONLY_TOOL_NAMES as readonly string[]).includes(n))).toBe(false);
  });
});
