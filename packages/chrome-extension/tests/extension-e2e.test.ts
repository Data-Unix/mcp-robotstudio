import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RwsClient } from "../../mcp-robotstudio/dist/rws/index.js";
import { FakeRwsServer } from "../../mcp-robotstudio/dist/testing/fake-rws-server.js";
// @ts-expect-error plain .mjs build script without types
import { buildExtension } from "../build.mjs";
// @ts-expect-error plain .mjs helper without types
import { generateKeyPair, issueToken } from "../scripts/license-lab.mjs";

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(EXTENSION_DIR, "../..");
const RSPAG = path.join(ROOT, "practicas/6.3-colisiones-interrupciones/entregables/Practica63_Final.rspag");
const FINAL_MOD = path.join(ROOT, "practicas/6.3-colisiones-interrupciones/rapid/Practica63_Final.mod");
// practicas/ is not in the public export: use a synthetic module there and skip the .rspag steps.
const HAS_PRACTICAS = fs.existsSync(FINAL_MOD) && fs.existsSync(RSPAG);
const MODULE_SOURCE = HAS_PRACTICAS
  ? fs.readFileSync(FINAL_MOD, "utf8")
  : ["MODULE Practica63_Final", "    CONST num ALTO:=30;", ...Array.from({ length: 49 }, (_, i) => `    ! linea ${i + 3}`), "        MoveL Offs(pInterrupcion,0,0,SEGURIDAD),v300,fine,MyTool\\WObj:=wobj0;", ...Array.from({ length: 6 }, () => "    !"), "ENDMODULE", ""].join("\n");
const TABS = ["01 TELEMETRIA Y CINEMATICA", "02 FORENSE Y DIFF", "03 OSCILOSCOPIO Y FLOTA", "04 ALCANCE Y RECETAS", "05 ESTUDIO DE PRACTICAS"];

describe("Chrome Extension MV3 E2E: 5 tabs, FREE vs PRO, against FakeRwsServer + WebSocket", () => {
  let server: FakeRwsServer;
  let baseUrl: string;
  let tmp: string;
  let distE2e: string;
  let context: BrowserContext;
  let extensionId: string;
  let proToken: string;
  let chromeProc: ChildProcess | undefined;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rs-ext-e2e-"));
    distE2e = path.join(tmp, "dist");
    const keys = (await generateKeyPair()) as { privateJwk: JsonWebKey; publicJwk: JsonWebKey };
    proToken = (await issueToken(keys.privateJwk, "e2e", 30)) as string;
    await buildExtension({ outDir: distE2e, licensePublicKey: keys.publicJwk });

    server = new FakeRwsServer();
    baseUrl = await server.start();
    server.defineModule("Practica63_Final", MODULE_SOURCE);
    server.defineModule("CalibData", "MODULE CalibData\n    PERS tooldata MyTool:=[TRUE,[[31.792631019,0,229.638935148],[0.945518576,0,0.325568154,0]],[1,[0,0,1],[1,0,0,0],0,0,0]];\nENDMODULE\n");
    server.defineSymbol("T_ROB1/Practica63_Final/pInterrupcion", "[[400,10,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", "per", "robtarget");
    server.defineSymbol("T_ROB1/Practica63_Final/pVuelta", "[[400,10,205.2],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", "per", "robtarget");
    server.pcp = { module: "Practica63_Final", routine: "recorrer_array", line: 52, column: 9 };
    server.opmode = "AUTO";
    server.speedRatio = 50;
    server.addEvent({ code: "40520", msgtype: "3", src: "RAPID", title: "Load error", desc: "syntax error" });

    const chromePath = process.env.MCP_RS_E2E_CHROME;
    if (chromePath) {
      // Google Chrome >= 137 ignores --load-extension: load it through CDP, like
      // "Load unpacked" (used on Windows PCs where Playwright's Chromium cannot start).
      chromeProc = spawn(chromePath, [
        "--remote-debugging-port=0",
        "--enable-unsafe-extension-debugging",
        `--user-data-dir=${path.join(tmp, "profile")}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
        "--window-size=1280,800",
        "about:blank",
      ]);
      const port = await new Promise<string>((resolve, reject) => {
        let buf = "";
        chromeProc!.stderr!.on("data", (d: Buffer) => {
          buf += d.toString();
          const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(buf);
          if (m) resolve(m[1]!);
        });
        chromeProc!.on("exit", (c) => reject(new Error(`chrome exited ${c}`)));
      });
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const cdp = await browser.newBrowserCDPSession();
      extensionId = ((await cdp.send("Extensions.loadUnpacked" as never, { path: distE2e } as never)) as { id: string }).id;
      context = browser.contexts()[0]!;
    } else {
      context = await chromium.launchPersistentContext(path.join(tmp, "profile"), {
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        args: [`--disable-extensions-except=${distE2e}`, `--load-extension=${distE2e}`],
      });
      const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
      extensionId = new URL(sw.url()).host;
    }
  }, 60_000);

  afterAll(async () => {
    await context?.close().catch(() => undefined);
    if (chromeProc && chromeProc.exitCode === null) {
      const exited = new Promise((r) => chromeProc!.once("exit", r));
      chromeProc.kill();
      await exited;
    }
    await server?.stop();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });

  async function openPanel(): Promise<Page> {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`chrome-extension://${extensionId}/panel.html`, { waitUntil: "domcontentloaded" });
    await expect.poll(async () => page.locator("#connection-badge").textContent(), { timeout: 10_000 }).toContain("IRB120_3_58");
    return page;
  }
  const tab = (page: Page, n: number) => page.click(`#tab-0${n}`);
  const shot = async (page: Page, name: string) => {
    const file = path.join(tmp, `${name}.png`);
    await page.screenshot({ path: file });
    const png = fs.readFileSync(file);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 800]);
  };

  it("FREE: configures options, renders the 5 tabs and walls every PRO feature", async () => {
    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extensionId}/options.html`);
    await opt.fill("#opt-port", new URL(baseUrl).port);
    await opt.click("#test-btn");
    await expect.poll(async () => opt.locator("#status-banner").textContent(), { timeout: 10_000 }).toContain("6.16.3007");
    const local = await opt.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    expect(local).not.toContain("robotics");
    await opt.close();

    const page = await openPanel();
    expect(await page.locator(".tab").allTextContents()).toEqual(TABS);
    expect(await page.locator("#plan-badge").textContent()).toBe("FREE");
    expect(await page.locator(".card.pro.locked").count()).toBeGreaterThanOrEqual(14);
    for (const b of await page.locator("button.write").all()) expect(await b.isDisabled()).toBe(true);

    // 01 free telemetry
    const ctrl = (await page.locator("#controller-grid").textContent()) ?? "";
    expect(ctrl).toContain("guardstop");
    expect(ctrl).toContain("AUTO");
    expect(await page.locator("#motion-grid").textContent()).toContain("X=374.0");
    expect(await page.locator("#motion-grid").textContent()).toContain("[0.70711, 0.00000, 0.70711, 0.00000]");
    expect(await page.locator("#modules-body").textContent()).toContain("Practica63_Final");
    await shot(page, "free-01");

    // 02: last 5 events + stop indicator; forensic capture opens the conversion wall
    await tab(page, 2);
    expect(await page.locator("#events-body tr").count()).toBe(5);
    expect(await page.locator("#events-body").textContent()).toContain("40520");
    expect(await page.locator("#stop-indicator").isVisible()).toBe(true);
    await page.click("#panel-02 .card.pro .upgrade >> nth=0");
    expect(await page.locator("#license-dialog").isVisible()).toBe(true);
    await page.click("#license-close");

    // 03: signal list with filter
    await tab(page, 3);
    await page.fill("#signal-filter", "BRAKE");
    expect(await page.locator("#signals-count").textContent()).toBe("2/5");
    await page.fill("#signal-filter", "");

    // 04: symbol reader + basic converter
    await tab(page, 4);
    await page.click("#read-symbol-btn");
    await expect.poll(async () => page.locator("#symbol-output").textContent()).toContain("T_ROB1/BASE/tool0 = [TRUE");
    await page.click("#conv-e2q");
    expect(await page.locator("#conv-out").textContent()).toBe("[0.000000,0.000000,1.000000,0.000000]");

    // 05: checklist + real .rspag audit in the Web Worker
    await tab(page, 5);
    if (HAS_PRACTICAS) expect(await page.locator("#checklist input[type=checkbox]").count()).toBeGreaterThan(10);
    if (HAS_PRACTICAS) {
      await page.setInputFiles("#rspag-input", RSPAG);
      await expect.poll(async () => page.locator("#rspag-out").textContent(), { timeout: 15_000 }).toContain("VEREDICTO: OK");
      expect(await page.locator("#rspag-out").textContent()).toContain("{7A8BF1E4-734F-4AE3-848F-F8433D77861B}");
    }
    await page.close();
  }, 90_000);

  it("PRO: licence + session write mode unlock every tab, WebSocket oscilloscope included", async () => {
    const page = await openPanel();
    await tab(page, 1);
    await page.click("#panel-01 .upgrade >> nth=0");
    await page.fill("#license-token", proToken);
    await page.click("#license-activate");
    await expect.poll(async () => page.locator("#plan-badge").textContent()).toBe("PRO");
    expect(await page.locator(".card.pro.locked").count()).toBe(0);

    const opt = await context.newPage();
    await opt.goto(`chrome-extension://${extensionId}/options.html`);
    await opt.check("#opt-write");
    await expect.poll(async () => opt.locator("#status-banner").textContent()).toContain("ACTIVO");
    await opt.close();
    await page.reload();
    await expect.poll(async () => page.locator("#write-badge").textContent(), { timeout: 10_000 }).toBe("ESCRITURA ACTIVA");

    // 01: PCP, speed alert, Fijar 100%, singularity, converter
    await expect.poll(async () => page.locator("#pcp-grid").textContent(), { timeout: 10_000 }).toContain("Practica63_Final / recorrer_array / linea 52:9");
    expect(await page.locator("#speed-alert").textContent()).toContain("x2.00");
    expect(await page.locator("#singularity-grid").textContent()).toContain("SINGULAR");
    expect(await page.locator(".bar-row").count()).toBe(6);
    await page.click("#pc-run");
    expect(await page.locator("#pc-out").textContent()).toContain("PoseMult(A,B)       = [[300.000,0.000,250.000]");
    await shot(page, "pro-01");
    await page.click("#speed-fix-btn");
    await expect.poll(() => server.speedRatio).toBe(100);

    // 02: forensic black box, Time-Machine diff, offline validator
    await tab(page, 2);
    await page.click("#forensic-btn");
    await expect.poll(async () => page.locator("#forensic-out").textContent(), { timeout: 15_000 }).toContain(">  52");
    expect(await page.locator("#forensic-out").textContent()).toContain("loadmod-204-with-errors");
    const golden = path.join(tmp, "golden.mod");
    fs.writeFileSync(golden, MODULE_SOURCE.replace("CONST num ALTO", "CONST num ALTO_GOLDEN"));
    await page.setInputFiles("#diff-file", golden);
    await page.click("#diff-btn");
    await expect.poll(async () => page.locator("#diff-summary").textContent(), { timeout: 10_000 }).toContain("DIFERENTE");
    expect(await page.locator("#diff-out .diff-add").count()).toBeGreaterThan(0);
    await page.fill("#val-src", "MODULE X\n  PROC main()\nENDMODULE");
    await page.click("#val-btn");
    expect(await page.locator("#val-out").textContent()).toContain("CON ERRORES");
    await shot(page, "pro-02");

    // 03: oscilloscope in the offscreen document. The subscription is created
    // (POST /subscription 201) but Chrome sends no session cookie on the
    // WebSocket handshake from an extension page -> 401 -> automatic polling.
    await tab(page, 3);
    await page.check("input.scope-sig[value=DRV1TESTE2]");
    await page.click("#scope-start");
    await expect.poll(async () => page.locator("#scope-status").textContent(), { timeout: 10_000 }).toContain("polling (WebSocket upgrade refused)");
    expect(server.requestLog.some((l) => l.startsWith("POST /subscription"))).toBe(true);
    expect(server.requestLog.find((l) => l.startsWith("WS-REJECT"))).toMatch(/401 Unauthorized cookie=no protocol=robapi2_subscription/);
    await new RwsClient({ baseUrl }).setSignal("DRV1TESTE2", 1);
    await expect.poll(async () => page.locator("#scope-legend").textContent(), { timeout: 10_000 }).toContain("DRV1TESTE2=1");
    await expect.poll(async () => page.locator("#scope-legend").textContent(), { timeout: 10_000 }).toMatch(/TCP X=374\.00/);
    await page.click("#cert-btn");
    await expect.poll(async () => page.locator("#cert-body").textContent()).toContain("0.2000");
    await page.click("#fleet-btn");
    await expect.poll(async () => page.locator("#fleet-body").textContent()).toContain("Synchronized");
    await shot(page, "pro-03");
    await page.click("#scope-stop");

    // 04: reach probe, teach-by-showing, recipe shield
    await tab(page, 4);
    await page.click("#rp-btn");
    expect(await page.locator("#rp-out").textContent()).toContain("Primera orientacion valida");
    await page.click("#tb-btn");
    await expect.poll(async () => page.locator("#tb-out").textContent()).toContain("CONST robtarget pNuevo:=[[374.00,0.00,630.00]");
    await page.click("#rc-load");
    await expect.poll(async () => page.locator("#rc-value").inputValue()).toContain("[[400,10,205]");
    await page.fill("#rc-value", "[[400,300,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]");
    await page.click("#rc-check");
    await expect.poll(async () => page.locator("#rc-out").textContent()).toContain("BLOQUEADO");
    await shot(page, "pro-04");

    // 05: live audit + generator + .rspag anonymize download
    await tab(page, 5);
    await page.click("#wz-audit");
    await expect.poll(async () => page.locator("#wz-audit-out").textContent()).toContain("MyTool");
    await page.selectOption("#wz-block", "pickplace");
    await page.click("#wz-generate");
    expect(await page.locator("#wz-out").textContent()).toContain("TRAP tr_parada");
    expect(await page.locator("#wz-out").textContent()).toContain("| Objetivo | Comprobacion | Evidencia | Verificado |");
    if (HAS_PRACTICAS) {
      await page.setInputFiles("#rspag-input", RSPAG);
      await expect.poll(async () => page.locator("#rspag-out").textContent(), { timeout: 15_000 }).toContain("VEREDICTO: OK");
      const dl = page.waitForEvent("download");
      await page.click("#rspag-anon");
      const download = await dl;
      expect(download.suggestedFilename()).toBe("Practica63_Final_anonimizado.rspag");
    }
    await shot(page, "pro-05");
    await page.close();
  }, 120_000);
});
