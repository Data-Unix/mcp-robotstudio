// Live compatibility matrix: every mcp-robotstudio feature the extension uses is
// called twice against the same controller, once through the MCP server (stdio,
// read-only) and once through the extension's service worker, and the results
// are compared. Run with RAPID stopped so poses are stable.
//
//   node scripts/compat-live.mjs --token <PRO token> [--port 80] [--rspag <file>] [--golden <file.mod>] [--out <report.md>]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(HERE, "dist");
const CLI = path.join(HERE, "..", "mcp-robotstudio", "dist", "cli.js");
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const port = arg("port", "80");
const token = arg("token");
const rspag = arg("rspag");
const golden = arg("golden");
const out = arg("out");
const MOD = arg("module", "Practica63_Final");

// ---- MCP side (read-only server, temporary audit log) ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rs-compat-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [CLI, "--rws-url", `http://127.0.0.1:${port}`, "--audit-log", path.join(tmp, "audit.jsonl"), "--agent", "compat"],
  stderr: "pipe",
});
const mcp = new Client({ name: "compat", version: "0.2.0" }, { capabilities: {} });
await mcp.connect(transport);
const tool = async (name, args = {}) => (await mcp.callTool({ name, arguments: args })).structuredContent;

// ---- extension side (clean Chrome profile, extension loaded through CDP) ----
const proc = spawn(arg("chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), [
  "--remote-debugging-port=0", "--enable-unsafe-extension-debugging", `--user-data-dir=${path.join(tmp, "profile")}`,
  "--no-first-run", "--no-default-browser-check", "--headless=new", "about:blank",
]);
const devPort = await new Promise((res, rej) => {
  let b = "";
  proc.stderr.on("data", (d) => {
    b += d;
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(b);
    if (m) res(m[1]);
  });
  proc.on("exit", (c) => rej(new Error(`chrome exited ${c}`)));
});
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${devPort}`);
const { id } = await (await browser.newBrowserCDPSession()).send("Extensions.loadUnpacked", { path: EXT });
const page = await browser.contexts()[0].newPage();
await page.goto(`chrome-extension://${id}/panel.html`);
const ext = (req) => page.evaluate((r) => chrome.runtime.sendMessage(r), req);
const extOk = async (req) => {
  const r = await ext(req);
  if (!r.ok) throw new Error(`${req.action}: ${r.error}`);
  return "result" in r ? r.result : r;
};
await page.evaluate(async (p) => {
  await chrome.storage.local.set({ rwsSettings: { host: "127.0.0.1", port: Number(p), task: "T_ROB1", username: "Default User", dialect: "rws1", fleet: [] } });
  await chrome.storage.session.set({ rwsPassword: "robotics" });
}, port);
if (token) await extOk({ action: "activateLicense", token });

// ---- comparisons ----
const rows = [];
const near = (a, b, tol = 1e-6) => a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol);
async function check(module, mcpTool, extAction, fn) {
  try {
    const { equal, mcpValue, extValue } = await fn();
    rows.push({ module, mcpTool, extAction, equal, mcpValue, extValue });
  } catch (e) {
    rows.push({ module, mcpTool, extAction, equal: false, mcpValue: "-", extValue: `ERROR ${e.message}` });
  }
}
const short = (v) => (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 90);

await check("rws (client)", "get_controller_state", "getDashboardData", async () => {
  const m = await tool("get_controller_state");
  const e = (await ext({ action: "getDashboardData" })).data.controller;
  const pick = (c) => [c.system.name, c.system.rwversion, c.panel.ctrlstate, c.panel.opmode, c.panel.ctrlexecstate, c.tasks[0]?.name].join(" | ");
  return { equal: pick(m) === pick(e), mcpValue: pick(m), extValue: pick(e) };
});
await check("rws (client)", "list_modules", "getDashboardData.modules", async () => {
  const m = (await tool("list_modules")).modules.join(",");
  const e = (await ext({ action: "getDashboardData" })).data.modules.modules.join(",");
  return { equal: m === e, mcpValue: m, extValue: e };
});
await check("rws (client)", "list_signals", "getSignals", async () => {
  const m = (await tool("list_signals", { limit: 200 })).signals.map((s) => `${s.name}=${s.value}`).sort().join(",");
  const e = (await ext({ action: "getSignals", filter: "", limit: 200 })).signals.map((s) => `${s.name}=${s.value}`).sort().join(",");
  return { equal: m === e, mcpValue: `${m.split(",").length} signals`, extValue: `${e.split(",").length} signals` };
});
await check("rws (client)", "get_event_log", "getDashboardData.events", async () => {
  const m = (await tool("get_event_log", { limit: 12 })).events.map((x) => `${x.code}@${x.time}`).join(",");
  const e = (await ext({ action: "getDashboardData" })).data.events.map((x) => `${x.code}@${x.time}`).join(",");
  return { equal: m === e, mcpValue: m.split(",").slice(0, 3).join(","), extValue: e.split(",").slice(0, 3).join(",") };
});
for (const [mod, sym] of [["CalibData", "MyTool"], [MOD, "pInterrupcion"], [MOD, "nPasadasArray"], ["BASE", "tool0"]]) {
  await check("rws (client)", `read_rapid_symbol ${mod}/${sym}`, "readSymbol", async () => {
    const m = (await tool("read_rapid_symbol", { module: mod, symbol: sym })).value;
    const e = (await ext({ action: "readSymbol", module: mod, symbol: sym })).symbolResult.value;
    return { equal: m === e, mcpValue: m, extValue: e };
  });
}
const tele = await extOk({ action: "getTelemetryPro", tool: "tool0", wobj: "wobj0" });
await check("rws (client)", "get_joints", "getTelemetryPro.joints", async () => {
  const m = (await tool("get_joints")).jointsDeg;
  return { equal: m.length === 6 && m.every((v, i) => near(v, tele.joints[i])), mcpValue: m, extValue: tele.joints };
});
await check("rws (client)", "get_tcp", "getTelemetryPro.tcp", async () => {
  const m = await tool("get_tcp");
  const k = ["x", "y", "z", "q1", "q2", "q3", "q4"];
  return { equal: k.every((x) => near(m[x], tele.tcp[x])), mcpValue: k.map((x) => m[x]), extValue: k.map((x) => tele.tcp[x]) };
});
await check("rws (client)", "get_program_pointer", "getTelemetryPro.pcp", async () => {
  const m = await tool("get_program_pointer");
  const f = (p) => `${p.programPointer.module ?? p.programPointer.errorCode}/${p.programPointer.routine ?? ""}:${p.programPointer.beginLine ?? ""}`;
  return { equal: f(m) === f(tele.pcp), mcpValue: f(m), extValue: f(tele.pcp) };
});
await check("rws (client)", "get_speed_ratio", "getTelemetryPro.speedRatio", async () => {
  const m = (await tool("get_speed_ratio")).speedRatio;
  return { equal: m === tele.speedRatio, mcpValue: m, extValue: tele.speedRatio };
});
await check("kinematics", "(checkJoints via get_joints)", "getTelemetryPro.safety", async () => {
  const k = await import("mcp-robotstudio/kinematics");
  const j = (await tool("get_joints")).jointsDeg;
  const local = k.checkJoints(j);
  const same = near(local.manipulability, tele.safety.manipulability, 1e-9) && local.wrist.singular === tele.safety.wrist.singular && near(local.elbow.distanceDeg, tele.safety.elbow.distanceDeg, 1e-9);
  return { equal: same, mcpValue: `w=${local.manipulability.toExponential(4)} |J5|=${local.wrist.distanceDeg.toFixed(3)}`, extValue: `w=${tele.safety.manipulability.toExponential(4)} |J5|=${tele.safety.wrist.distanceDeg.toFixed(3)}` };
});
await check("rws (client) + mechunit", "-", "getFleet.smbSync", async () => {
  const f = (await extOk({ action: "getFleet" })).rows[0];
  const m = await tool("get_controller_state");
  return { equal: f.system === m.system.name && f.smbSync === "Synchronized", mcpValue: m.system.name, extValue: `${f.system} ${f.smbSync}` };
});
await check("rws (client)", "read_module_source", "readModuleSource", async () => {
  const m = (await tool("read_module_source", { module: MOD })).source;
  const e = (await extOk({ action: "readModuleSource", module: MOD })).source;
  return { equal: m === e && m.length > 0, mcpValue: `${m.length} chars`, extValue: `${e.length} chars` };
});
if (golden) {
  await check("rapid/diff", "diff_module_with_golden", "panel Time-Machine Diff (same lib)", async () => {
    const d = await import("mcp-robotstudio/rapid/diff");
    const m = await tool("diff_module_with_golden", { module: MOD, goldenPath: golden });
    const live = (await extOk({ action: "readModuleSource", module: MOD })).source;
    const e = d.diffModules(fs.readFileSync(golden, "utf8"), live);
    return { equal: m.added === e.added && m.removed === e.removed, mcpValue: `+${m.added}/-${m.removed}`, extValue: `+${e.added}/-${e.removed}` };
  });
  await check("rapid/validator", "validate_rapid_offline", "panel validator (same lib)", async () => {
    const v = await import("mcp-robotstudio/rapid/validator");
    const src = fs.readFileSync(golden, "utf8");
    const m = await tool("validate_rapid_offline", { content: src, checkReach: true });
    const e = v.validateRapidModule(src, { checkReach: true });
    return { equal: m.errors === e.errors && m.warnings === e.warnings, mcpValue: `errors ${m.errors} warnings ${m.warnings}`, extValue: `errors ${e.errors} warnings ${e.warnings}` };
  });
}
await check("forensics", "capture_forensic_blackbox", "captureForensic", async () => {
  const m = await tool("capture_forensic_blackbox", { contextLines: 2 });
  const e = await extOk({ action: "captureForensic", contextLines: 2 });
  const f = (x) => `${x.diagnosis.map((d) => d.id).sort().join("+") || "none"} pp=${x.pcp?.programPointer?.beginLine ?? x.pcp?.programPointer?.errorCode}`;
  return { equal: f(m) === f(e), mcpValue: f(m), extValue: f(e) };
});
await check("recipes (shield)", "write_rapid_symbol shield (no write)", "checkRecipeWrite (same lib)", async () => {
  const r = await import("mcp-robotstudio/recipes");
  const cur = (await tool("read_rapid_symbol", { module: MOD, symbol: "pInterrupcion" })).value;
  const bumped = cur.replace(/^\[\[\s*(-?[\d.E+-]+)/i, (_x, v) => `[[${Number(v) + 200}`);
  const a = r.checkRecipeWrite("robtarget", cur, bumped, { deltaMaxMm: 50 });
  return { equal: !a.allowed && /delta_max/.test(a.reasons.join()), mcpValue: "blocked expected", extValue: a.reasons.join("; ") };
});
await check("kinematics (StorePath cert)", "read_rapid_symbol x2", "getStorePathCert", async () => {
  const k = await import("mcp-robotstudio/kinematics");
  const a = k.parsePoseLiteral((await tool("read_rapid_symbol", { module: MOD, symbol: "pInterrupcion" })).value);
  const b = k.parsePoseLiteral((await tool("read_rapid_symbol", { module: MOD, symbol: "pVuelta" })).value);
  const e = await extOk({ action: "getStorePathCert", module: MOD, stopSymbol: "pInterrupcion", returnSymbol: "pVuelta" });
  const mm = k.distance(a.trans, b.trans);
  return { equal: near(mm, e.errorMm, 1e-9), mcpValue: `${mm.toFixed(4)} mm`, extValue: `${e.errorMm.toFixed(4)} mm` };
});
await check("practice (live audit)", "read_rapid_symbol CalibData/MyTool", "getLiveAudit.tools", async () => {
  const m = (await tool("read_rapid_symbol", { module: "CalibData", symbol: "MyTool" })).value;
  const e = (await extOk({ action: "getLiveAudit" })).tools.find((t) => t.name === "MyTool");
  const k = await import("mcp-robotstudio/kinematics");
  const pm = k.parsePoseLiteral(m.replace(/^\s*\[\s*TRUE\s*,/i, "["));
  const pe = k.parsePoseLiteral(e.value.replace(/^\s*\[\s*TRUE\s*,/i, "["));
  const same = pm.trans.every((v, i) => near(v, pe.trans[i], 1e-3)) && pm.rot.every((v, i) => near(v, pe.rot[i], 1e-5));
  return { equal: same, mcpValue: m, extValue: e.value };
});
if (rspag) {
  await check("rspag (audit)", "audit_rspag_package", "rspag-worker audit", async () => {
    const m = await tool("audit_rspag_package", { path: rspag });
    const bytes = Array.from(fs.readFileSync(rspag));
    const e = await page.evaluate(async (arr) => {
      const w = new Worker(chrome.runtime.getURL("rspag-worker.js"), { type: "module" });
      const buffer = new Uint8Array(arr).buffer;
      return await new Promise((res) => {
        w.onmessage = (ev) => res(ev.data);
        w.postMessage({ id: 1, op: "audit", buffer }, [buffer]);
      });
    }, bytes);
    const f = (r) => `${r.verdict} ${r.controllers.map((c) => `${c.systemGuid}/${c.templateGuid}`).join(",")} privacy=${r.privacy.length}`;
    return { equal: f(m) === f(e.report), mcpValue: f(m), extValue: f(e.report) };
  });
}
await check("rws (dialect)", "stderr dialect=auto->rws1", "client.dialect (telemetry)", async () => ({ equal: tele.dialect === "rws1", mcpValue: "rws1", extValue: tele.dialect }));

// ---- report ----
const pass = rows.filter((r) => r.equal).length;
const md = [
  `# Matriz de compatibilidad MCP / extensión (en vivo)`,
  "",
  `Controlador http://127.0.0.1:${port}, ${new Date().toISOString()}. Servidor MCP v0.2.0 en solo lectura; extensión 0.2.0 cargada por CDP con licencia de laboratorio.`,
  "",
  "| Módulo | Herramienta MCP | Acción de la extensión | Igual | MCP | Extensión |",
  "|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.module} | \`${r.mcpTool}\` | \`${r.extAction}\` | ${r.equal ? "sí" : "NO"} | ${short(r.mcpValue).replace(/\|/g, "/")} | ${short(r.extValue).replace(/\|/g, "/")} |`),
  "",
  `Resultado: ${pass}/${rows.length} iguales.`,
].join("\n");
console.log(md);
if (out) fs.writeFileSync(out, `${md}\n`);
await mcp.close();
await browser.close().catch(() => undefined);
proc.kill();
await new Promise((r) => setTimeout(r, 1200));
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
process.exit(pass === rows.length ? 0 : 1);
