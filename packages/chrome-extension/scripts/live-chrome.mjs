// Live check of the built extension (dist/) in installed Google Chrome against a
// real controller. Chrome >= 137 ignores --load-extension, so the extension is
// loaded through CDP Extensions.loadUnpacked (what "Load unpacked" does).
//
//   node scripts/live-chrome.mjs --port 80 [--token <PRO token>] [--write] [--shots <dir>]
//     [--golden <Golden.mod>] [--rspag <file.rspag>] [--module <RAPID module>]
//
// Screenshots cover the page viewport only (1280x800): never the desktop,
// the taskbar or notifications.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const chromePath = arg("chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
const port = arg("port", "80");
const token = arg("token", "");
const shots = arg("shots", "");
const golden = arg("golden", "");
const rspag = arg("rspag", "");
const moduleName = arg("module", "Practica63_Final");
const write = process.argv.includes("--write");

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rs-live-"));
const proc = spawn(chromePath, [
  "--remote-debugging-port=0",
  "--enable-unsafe-extension-debugging",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--headless=new",
  "--window-size=1280,800",
  "about:blank",
]);
const devPort = await new Promise((resolve, reject) => {
  let buf = "";
  proc.stderr.on("data", (d) => {
    buf += d;
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(buf);
    if (m) resolve(m[1]);
  });
  proc.on("exit", (c) => reject(new Error(`chrome exited ${c}`)));
});
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${devPort}`);
const cdp = await browser.newBrowserCDPSession();
const { id } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
const ctx = browser.contexts()[0];
const log = (k, v) => console.log(`### ${k}\n${typeof v === "string" ? v : JSON.stringify(v, null, 1)}\n`);
const versionOf = await (async () => {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/options.html`);
  const v = await p.evaluate(() => chrome.runtime.getManifest().version);
  await p.close();
  return v;
})();
log("extension cargada por CDP", { id, version: versionOf });

const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${id}/options.html`);
await opt.fill("#opt-port", port);
await opt.click("#test-btn");
await opt.waitForFunction(() => /Conexion verificada|Error/.test(document.querySelector("#status-banner")?.textContent ?? ""), null, { timeout: 15000 });
log("Opciones > Probar conexion", await opt.locator("#status-banner").textContent());
if (token) {
  await opt.fill("#opt-license", token);
  await opt.click("#license-btn");
  await opt.waitForTimeout(1000);
  log("Licencia", await opt.locator("#license-info").textContent());
}
if (write) {
  await opt.check("#opt-write");
  await opt.waitForTimeout(500);
}
log("chrome.storage.local (claves)", await opt.evaluate(async () => Object.keys(await chrome.storage.local.get(null))));
log("chrome.storage.session (claves)", await opt.evaluate(async () => Object.keys(await chrome.storage.session.get(null))));
await opt.close();

const page = await ctx.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(`chrome-extension://${id}/panel.html`);
await page.waitForFunction(() => /OK$/.test(document.querySelector("#connection-badge")?.textContent ?? ""), null, { timeout: 20000 });
const text = async (sel) => ((await page.locator(sel).textContent()) ?? "").trim();
const tab = async (n) => {
  await page.click(`#tab-0${n}`);
  await page.evaluate(() => window.scrollTo(0, 0));
};
const shot = async (name) => {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(shots, name), fullPage: false });
};
const until = (fn, ms = 15000) => page.waitForFunction(fn, null, { timeout: ms });

log("cabecera", { plan: await text("#plan-badge"), conexion: await text("#connection-badge"), escritura: await text("#write-badge"), pestanas: await page.locator(".tab").allTextContents() });

// 01 TELEMETRIA Y CINEMATICA
await tab(1);
log("01 estado", await text("#controller-grid"));
log("01 ejes/TCP", await text("#motion-grid"));
log("01 modulos", await text("#modules-body"));
if (token) {
  await until(() => /PP/.test(document.querySelector("#pcp-grid")?.textContent ?? ""));
  log("01 PCP/speed", await text("#pcp-grid"));
  log("01 singularidades", await text("#singularity-grid"));
  log("01 barras", await page.locator(".bar-row").allTextContents());
  await page.click("#pc-run");
  log("01 conversor", await text("#pc-out"));
  if (process.argv.includes("--fix-speed")) {
    log("01 alerta speed", await text("#speed-alert"));
    await page.click("#speed-fix-btn");
    await until(() => /SpeedRatio =|Error/.test(document.querySelector("#speed-fix-out")?.textContent ?? ""));
    log("01 Fijar 100%", await text("#speed-fix-out"));
    log("01 PCP/speed tras fijar", await text("#pcp-grid"));
  }
}
if (process.argv.includes("--only-01")) {
  await browser.close().catch(() => undefined);
  proc.kill();
  process.exit(0);
}
await shot("cws-01-telemetria-cinematica-1280x800.png");

// 02 FORENSE Y DIFF
await tab(2);
log("02 eventos", await page.locator("#events-body tr").allTextContents());
log("02 indicador parada", await text("#stop-indicator"));
if (token) {
  await page.click("#forensic-btn");
  await until(() => /Informe forense|Error/.test(document.querySelector("#forensic-out")?.textContent ?? ""), 20000);
  log("02 caja negra", await text("#forensic-out"));
  if (golden) {
    await page.fill("#diff-module", moduleName);
    await page.setInputFiles("#diff-file", golden);
    await page.click("#diff-btn");
    await until(() => /IDENTICO|DIFERENTE|Error/.test(document.querySelector("#diff-summary")?.textContent ?? "") || /Error/.test(document.querySelector("#diff-out")?.textContent ?? ""), 20000);
    log("02 diff", `${await text("#diff-summary")}\n${await text("#diff-out")}`);
    await page.setInputFiles("#val-file", golden);
    await page.click("#val-btn");
    await page.waitForTimeout(1500);
    log("02 validador", await text("#val-out"));
  }
}
await shot("cws-02-forense-diff-1280x800.png");

// 03 OSCILOSCOPIO Y FLOTA
await tab(3);
await page.fill("#signal-filter", "");
log("03 senales", await text("#signals-count"));
if (token) {
  await page.fill("#signal-filter", "A");
  for (const s of ["ARRAY", "INTERRUPCION"]) {
    const cb = page.locator(`input.scope-sig[value=${s}]`);
    if (await cb.count()) await cb.check();
  }
  await page.fill("#scope-pers", `${moduleName}/nCeldasMatriz,${moduleName}/nPasadasArray`);
  await page.click("#scope-start");
  await page.waitForTimeout(9000);
  log("03 osciloscopio estado", await text("#scope-status"));
  log("03 osciloscopio leyenda", await text("#scope-legend"));
  await page.click("#cert-btn");
  await page.waitForTimeout(1500);
  log("03 certificador", await page.locator("#cert-body tr").allTextContents());
  await page.click("#fleet-btn");
  await page.waitForTimeout(2000);
  log("03 flota", await page.locator("#fleet-body tr").allTextContents());
}
await shot("cws-03-osciloscopio-flota-1280x800.png");
if (token) await page.click("#scope-stop");

// 04 ALCANCE Y RECETAS
await tab(4);
await page.fill("#symbol-module", "CalibData");
await page.fill("#symbol-name", "MyTool");
await page.click("#read-symbol-btn");
await until(() => /=|Error/.test(document.querySelector("#symbol-output")?.textContent ?? ""));
log("04 simbolo", await text("#symbol-output"));
await page.click("#conv-e2q");
log("04 conversor", await text("#conv-out"));
if (token) {
  await page.click("#rp-btn");
  log("04 sonda", `${await text("#rp-out")}\n${(await page.locator("#rp-body tr").allTextContents()).join("\n")}`);
  await page.fill("#tb-tool", "MyTool");
  await page.click("#tb-btn");
  await until(() => /robtarget|Error/.test(document.querySelector("#tb-out")?.textContent ?? ""));
  log("04 teach", await text("#tb-out"));
  await page.fill("#rc-module", moduleName);
  await page.fill("#rc-symbol", "pInterrupcion");
  await page.click("#rc-load");
  await page.waitForTimeout(1200);
  const cur = await page.locator("#rc-value").inputValue();
  const bumped = cur.replace(/^\[\[\s*(-?[\d.]+)/, (_m, x) => `[[${Number(x) + 200}`);
  await page.fill("#rc-value", bumped);
  await page.click("#rc-check");
  await page.waitForTimeout(1500);
  log("04 escudo receta (+200 mm en X)", await text("#rc-out"));
}
await shot("cws-04-alcance-recetas-1280x800.png");

// 05 ESTUDIO DE PRACTICAS
await tab(5);
log("05 checklist", `${await page.locator("#checklist input").count()} items`);
if (rspag) {
  await page.setInputFiles("#rspag-input", rspag);
  await until(() => /VEREDICTO|Error/.test(document.querySelector("#rspag-out")?.textContent ?? ""), 30000);
  log("05 auditoria rspag (Web Worker)", await text("#rspag-out"));
}
if (token) {
  await page.click("#wz-audit");
  await until(() => /EIO|Error/.test(document.querySelector("#wz-audit-out")?.textContent ?? ""), 20000);
  log("05 auditoria controlador", await text("#wz-audit-out"));
  await page.selectOption("#wz-block", "pickplace");
  await page.fill("#wz-di", "INTERRUPCION");
  await page.click("#wz-generate");
  log("05 generador (cabecera)", (await text("#wz-out")).split("\n").slice(0, 14).join("\n"));
  log("05 incidentes", await text("#wz-incidents"));
}
await shot("cws-05-estudio-practicas-1280x800.png");

await browser.close().catch(() => undefined);
proc.kill();
await new Promise((r) => setTimeout(r, 1500));
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
