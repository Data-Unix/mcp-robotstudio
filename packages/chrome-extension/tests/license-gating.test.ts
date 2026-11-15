import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeRwsServer } from "../../mcp-robotstudio/dist/testing/fake-rws-server.js";
// @ts-expect-error plain .mjs helper without types
import { generateKeyPair, issueToken } from "../scripts/license-lab.mjs";

// One key pair for the whole file; the extension is built against its public half.
const keys = (await generateKeyPair()) as { privateJwk: JsonWebKey; publicJwk: JsonWebKey };
vi.mock("../src/license-public-key.js", () => ({ LICENSE_PUBLIC_KEY: keys.publicJwk }));

// Minimal chrome.* stub (storage local/session, runtime) for the service worker module.
const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
const area = (m: Map<string, unknown>) => ({
  get: async (k?: string | null) => (k ? (m.has(k) ? { [k]: m.get(k) } : {}) : Object.fromEntries(m)),
  set: async (o: Record<string, unknown>) => void Object.entries(o).forEach(([k, v]) => m.set(k, v)),
  remove: async (k: string) => void m.delete(k),
  setAccessLevel: async () => undefined,
});
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: { local: area(local), session: area(session) },
  runtime: { id: "test", getURL: (p: string) => `chrome-extension://test/${p}`, onMessage: { addListener: () => undefined }, onInstalled: { addListener: () => undefined } },
  permissions: { contains: async () => true },
};
if (!globalThis.crypto) (globalThis as unknown as { crypto: unknown }).crypto = webcrypto;

const { verifyLicenseToken } = await import("../src/license.js");
const { handleRequest } = await import("../src/background.js");

let server: FakeRwsServer;
beforeAll(async () => {
  server = new FakeRwsServer();
  const port = Number(new URL(await server.start()).port);
  local.set("rwsSettings", { host: "127.0.0.1", port, task: "T_ROB1", username: "Default User", dialect: "rws1" });
  session.set("rwsPassword", "robotics");
});
afterAll(async () => server.stop());

describe("license token verification (ECDSA P-256)", () => {
  it("accepts a valid PRO token and rejects tampered, expired or foreign tokens", async () => {
    const tok = (await issueToken(keys.privateJwk, "aula-6", 30)) as string;
    expect(await verifyLicenseToken(tok, keys.publicJwk)).toMatchObject({ plan: "pro", subject: "aula-6" });
    const [body, sig] = tok.split(".");
    const forged = `${Buffer.from(JSON.stringify({ aud: "mcp-robotstudio-pro", plan: "pro", sub: "x" })).toString("base64url")}.${sig}`;
    expect((await verifyLicenseToken(forged, keys.publicJwk)).plan).toBe("free");
    expect((await verifyLicenseToken(`${body}.AAAA`, keys.publicJwk)).plan).toBe("free");
    const expired = (await issueToken(keys.privateJwk, "old", 1, Date.now() - 3 * 86400_000)) as string;
    expect(await verifyLicenseToken(expired, keys.publicJwk)).toMatchObject({ plan: "free", reason: "licencia caducada" });
    const other = await generateKeyPair();
    expect((await verifyLicenseToken((await issueToken(other.privateJwk, "x")) as string, keys.publicJwk)).plan).toBe("free");
    expect((await verifyLicenseToken("garbage", keys.publicJwk)).plan).toBe("free");
  });
});

describe("background gating: free vs PRO vs session write mode", () => {
  it("free plan: reads work, PRO reads and writes are refused before any RWS call", async () => {
    const r = await handleRequest({ action: "checkConnection" });
    expect(r).toMatchObject({ ok: true, connection: { system: { name: "IRB120_3_58" } } });
    const before = server.stats.requests;
    expect(await handleRequest({ action: "getTelemetryPro" })).toMatchObject({ ok: false, proRequired: true });
    expect(await handleRequest({ action: "setSpeedRatio", ratio: 100 })).toMatchObject({ ok: false, proRequired: true });
    expect(server.stats.requests).toBe(before);
  });

  it("PRO without write mode: PRO reads work, writes are refused", async () => {
    const act = await handleRequest({ action: "activateLicense", token: (await issueToken(keys.privateJwk, "aula-6")) as string });
    expect(act).toMatchObject({ ok: true, result: { plan: "pro" } });
    server.pcp = { module: "Practica63_Final", routine: "main", line: 80, column: 5 };
    server.opmode = "AUTO";
    server.speedRatio = 40;
    const t = (await handleRequest({ action: "getTelemetryPro" })) as { ok: true; result: Record<string, unknown> };
    expect(t.result).toMatchObject({ speedRatio: 40, speedAlert: true, cycleTimeFactor: 2.5 });
    expect((t.result.pcp as { programPointer: { beginLine: number } }).programPointer.beginLine).toBe(80);
    expect((t.result.safety as { wrist: { singular: boolean } }).wrist.singular).toBe(true); // fixture joints are all 0
    expect(await handleRequest({ action: "setSpeedRatio", ratio: 100 })).toMatchObject({ ok: false, writeModeRequired: true });
    expect(server.speedRatio).toBe(40);
  });

  it("PRO + write mode: writes go through the shield", async () => {
    await handleRequest({ action: "setWriteMode", enabled: true });
    expect(await handleRequest({ action: "setSpeedRatio", ratio: 100 })).toMatchObject({ ok: true, result: { speedRatio: 100 } });
    server.defineSymbol("T_ROB1/Rec/pPick", "[[340,90,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", "per", "robtarget");
    const blocked = (await handleRequest({ action: "writeRecipe", module: "Rec", symbol: "pPick", value: "[[340,390,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", deltaMaxMm: 50 })) as { ok: true; result: { written: boolean } };
    expect(blocked.result.written).toBe(false);
    const fine = (await handleRequest({ action: "writeRecipe", module: "Rec", symbol: "pPick", value: "[[345,90,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", deltaMaxMm: 50 })) as { ok: true; result: { written: boolean } };
    expect(fine.result.written).toBe(true);
    const bad = (await handleRequest({ action: "loadModuleSafe", fileName: "X.mod", content: "MODULE X\n  PROC main()\nENDMODULE" })) as { ok: true; result: { loaded: boolean; stage: string } };
    expect(bad.result).toMatchObject({ loaded: false, stage: "offline-validation" });
    const bk = (await handleRequest({ action: "triggerBackup", dirName: "bk_ext" })) as { ok: true; result: { backupPath: string } };
    expect(bk.result.backupPath).toBe("$TEMP/bk_ext");
    await handleRequest({ action: "setWriteMode", enabled: false });
    expect(await handleRequest({ action: "triggerBackup", dirName: "x" })).toMatchObject({ writeModeRequired: true });
  });

  it("PRO reads: forensic, fleet, StorePath certificate, live audit", async () => {
    server.defineModule("CalibData", "MODULE CalibData\n    PERS tooldata MyTool:=[TRUE,[[31.79,0,229.64],[0.9455,0,0.3256,0]],[1,[0,0,1],[1,0,0,0],0,0,0]];\nENDMODULE\n");
    server.defineSymbol("T_ROB1/Practica63_Final/pInterrupcion", "[[400,10,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", "per", "robtarget");
    server.defineSymbol("T_ROB1/Practica63_Final/pVuelta", "[[400,10.3,205.4],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", "per", "robtarget");
    const cert = (await handleRequest({ action: "getStorePathCert", module: "Practica63_Final", stopSymbol: "pInterrupcion", returnSymbol: "pVuelta" })) as { ok: true; result: { errorMm: number; errorDeg: number } };
    expect(cert.result.errorMm).toBeCloseTo(0.5, 6);
    expect(cert.result.errorDeg).toBeCloseTo(0, 6);
    const audit = (await handleRequest({ action: "getLiveAudit" })) as { ok: true; result: { tools: Array<{ name: string }> } };
    expect(audit.result.tools.map((t) => t.name)).toEqual(["MyTool"]);
    const fleet = (await handleRequest({ action: "getFleet" })) as { ok: true; result: { rows: Array<Record<string, unknown>> } };
    expect(fleet.result.rows[0]).toMatchObject({ cell: "principal", system: "IRB120_3_58", smbSync: "Synchronized" });
    const f = (await handleRequest({ action: "captureForensic", contextLines: 1 })) as { ok: true; result: { markdown: string } };
    expect(f.result.markdown).toContain("Informe forense");
    expect(server.tempFileNames).toEqual([]);
  });
});
