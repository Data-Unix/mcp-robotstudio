// Records the extension panel for the promotional clip: a VISIBLE Chrome window
// (clean temporary profile, extension loaded through CDP) placed next to
// RobotStudio, driven through the 5 tabs on a fixed timeline against the live
// controller. Frames are timestamped JPEGs of the page viewport only (no window
// frame, no desktop), taken with the CDP screencast; Remotion assembles the clip.
// Window position and size are in DIP (screen pixels divided by the display scale).
//
//   node scripts/video-live.mjs --out <dir> --token <PRO token> --rspag <file> --golden <file.mod>
//        [--x 861 --y 0 --w 528 --h 825] [--port 80] [--module Practica63_Final]
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
const out = arg("out");
const mod = arg("module", "Practica63_Final");
fs.mkdirSync(out, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rs-video-"));
const proc = spawn(arg("chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), [
  "--remote-debugging-port=0", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-notifications", "--hide-crash-restore-bubble",
  `--window-position=${arg("x", "861")},${arg("y", "0")}`, `--window-size=${arg("w", "528")},${arg("h", "825")}`, "about:blank",
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
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(`chrome-extension://${id}/options.html`);
await page.fill("#opt-port", arg("port", "80"));
await page.click("#test-btn");
await page.waitForFunction(() => /Conexion verificada/.test(document.querySelector("#status-banner")?.textContent ?? ""), null, { timeout: 15000 });
await page.fill("#opt-license", arg("token"));
await page.click("#license-btn");
await page.waitForTimeout(800);
await page.goto(`chrome-extension://${id}/panel.html`);
await page.waitForFunction(() => /OK$/.test(document.querySelector("#connection-badge")?.textContent ?? ""), null, { timeout: 20000 });
await page.click("#tab-01");
await page.waitForTimeout(1500);

const t0 = Date.now();
const marks = [];
// Screencast: one JPEG per painted frame, named by its wall-clock time in ms.
const cast = await ctx.newCDPSession(page);
cast.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  fs.writeFileSync(path.join(out, `${Math.round(metadata.timestamp * 1000)}.jpg`), Buffer.from(data, "base64"));
  cast.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
});
await cast.send("Page.startScreencast", { format: "jpeg", quality: 88 });
const at = async (sec, label, fn = async () => undefined) => {
  const wait = t0 + sec * 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  marks.push({ t: Date.now(), sec, label });
  await fn().catch((e) => marks.push({ t: Date.now(), sec, label: `error: ${e.message}` }));
};
const tab = (n) => page.click(`#tab-0${n}`);
const show = (sel) => page.evaluate((s) => document.querySelector(s)?.closest(".card")?.scrollIntoView({ block: "start" }), sel);
const top = () => page.evaluate(() => window.scrollTo(0, 0));

await at(0, "01-estado");
await at(2.5, "01-estado", () => page.click("#refresh-btn"));
await at(5, "01-pcp", () => show("#pcp-grid"));
await at(7, "01-pcp", () => page.click("#refresh-btn"));
await at(9.5, "01-limites", () => show("#limit-bars"));
await at(11, "01-limites", () => page.click("#refresh-btn"));
await at(13, "02-forense", async () => {
  await tab(2);
  await show("#forensic-out");
});
await at(14, "02-forense", () => page.click("#forensic-btn"));
await at(18, "02-diff", async () => {
  await show("#diff-out");
  await page.setInputFiles("#diff-file", arg("golden"));
});
await at(19, "02-diff", () => page.click("#diff-btn"));
await at(23, "03-osciloscopio", async () => {
  await tab(3);
  await page.fill("#signal-filter", "ARRAY");
  await page.check("input.scope-sig[value=ARRAY]");
  await page.fill("#scope-pers", `${mod}/nPasadasArray,${mod}/nCeldasMatriz`);
  await show("#scope-canvas");
});
await at(24, "03-osciloscopio", () => page.click("#scope-start"));
fs.writeFileSync(path.join(out, "pulse.txt"), `${t0 + 28000}\n`); // pulse ARRAY at t0+28 s
await at(52, "03-certificador", async () => {
  await show("#cert-body");
  await page.click("#cert-btn");
});
await at(56, "03-flota", async () => {
  await page.click("#scope-stop");
  await show("#fleet-body");
  await page.click("#fleet-btn");
});
await at(59, "04-sonda", async () => {
  await tab(4);
  await top();
  await show("#rp-body");
  await page.click("#rp-btn");
});
await at(63, "04-teach", async () => {
  await show("#tb-out");
  await page.fill("#tb-tool", "MyTool");
  await page.click("#tb-btn");
});
await at(67, "05-rspag", async () => {
  await tab(5);
  await top();
  await show("#rspag-out");
  await page.setInputFiles("#rspag-input", arg("rspag"));
});
await at(71, "05-asistente", async () => {
  await show("#wz-audit-out");
  await page.click("#wz-audit");
});
await at(74, "05-asistente", async () => {
  await page.selectOption("#wz-block", "pickplace");
  await page.click("#wz-generate");
});
await at(78, "fin");
await cast.send("Page.stopScreencast").catch(() => undefined);
fs.writeFileSync(path.join(out, "timeline.json"), JSON.stringify({ t0, marks }, null, 1));
await browser.close().catch(() => undefined);
proc.kill();
await new Promise((r) => setTimeout(r, 1500));
fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
console.log(`frames ${fs.readdirSync(out).filter((f) => f.endsWith(".jpg")).length} t0 ${t0}`);
