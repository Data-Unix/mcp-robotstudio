import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeRwsServer } from "../../mcp-robotstudio/dist/testing/fake-rws-server.js";

const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DIR = path.join(EXTENSION_DIR, "dist");
const SCREENSHOT_PATH = path.join(EXTENSION_DIR, "docs/panel-screenshot.png");

describe("Chrome Extension MV3 E2E against FakeRwsServer", () => {
  let server: FakeRwsServer;
  let baseUrl: string;
  let userDataDir: string;

  beforeAll(async () => {
    execFileSync(process.execPath, [path.join(EXTENSION_DIR, "build.mjs")], {
      stdio: "pipe",
    });
    fs.mkdirSync(path.dirname(SCREENSHOT_PATH), { recursive: true });

    server = new FakeRwsServer();
    baseUrl = await server.start();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rs-chrome-e2e-"));
  });

  afterAll(async () => {
    await server.stop();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it("connects via options, renders real RW6 state, filters signals, reads tool0, and stays strictly read-only", async () => {
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      viewport: { width: 560, height: 960 },
      args: [
        `--disable-extensions-except=${DIST_DIR}`,
        `--load-extension=${DIST_DIR}`,
      ],
    });

    try {
      let sw = context.serviceWorkers()[0];
      if (!sw) {
        sw = await context.waitForEvent("serviceworker", { timeout: 15_000 });
      }
      const extensionId = new URL(sw.url()).host;
      expect(extensionId).toMatch(/^[a-p]{32}$/);

      const fakePort = new URL(baseUrl).port;

      // 1. Configure port via Options page and verify read-only connection check
      const optionsPage = await context.newPage();
      await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, {
        waitUntil: "domcontentloaded",
      });
      await optionsPage.fill("#opt-port", fakePort);
      await optionsPage.click("#test-btn");

      const statusBanner = optionsPage.locator("#status-banner");
      await statusBanner.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(async () => await statusBanner.textContent(), { timeout: 10_000 })
        .toContain("IRB120_3_58");
      const statusText = (await statusBanner.textContent()) ?? "";
      expect(statusText).toContain("6.16.3007");
      expect(statusText).toContain("guardstop");

      // Verify password is NEVER stored in chrome.storage.local
      const localDump = await optionsPage.evaluate(async () => {
        return await chrome.storage.local.get(null);
      });
      expect(JSON.stringify(localDump)).not.toContain("robotics");
      expect(JSON.stringify(localDump)).not.toContain("rwsPassword");
      await optionsPage.close();

      // 2. Open panel.html and verify full read-only controller state
      const panelPage = await context.newPage();
      await panelPage.setViewportSize({ width: 560, height: 960 });
      await panelPage.goto(`chrome-extension://${extensionId}/panel.html`, {
        waitUntil: "domcontentloaded",
      });

      const badge = panelPage.locator("#connection-badge");
      await expect
        .poll(async () => await badge.textContent(), { timeout: 10_000 })
        .toContain("IRB120_3_58");

      const ctrlText = (await panelPage.locator("#controller-grid").textContent()) ?? "";
      expect(ctrlText).toContain("IRB120_3_58");
      expect(ctrlText).toContain("6.16.3007");
      expect(ctrlText).toContain("guardstop");
      expect(ctrlText).toContain("MANR");
      expect(ctrlText).toContain("stopped");
      expect(ctrlText).toContain("T_ROB1");

      const motionText = (await panelPage.locator("#motion-grid").textContent()) ?? "";
      expect(motionText).toContain("J1:0.0");
      expect(motionText).toContain("X=374.0");
      expect(motionText).toContain("Z=630.0");

      const modulesText = (await panelPage.locator("#modules-body").textContent()) ?? "";
      expect(modulesText).toContain("user");
      expect(modulesText).toContain("BASE");
      expect(modulesText).toContain("SysMod");

      // 3. Signals list + live substring filter
      const signalsText = (await panelPage.locator("#signals-body").textContent()) ?? "";
      expect(signalsText).toContain("DRV1TESTE2");
      expect(signalsText).toContain("DRV1BRAKEOK");

      await panelPage.fill("#signal-filter", "BRAKE");
      expect(await panelPage.locator("#signals-count").textContent()).toBe("2/5");

      await panelPage.fill("#signal-filter", "");
      expect(await panelPage.locator("#signals-count").textContent()).toBe("5/5");

      // 4. Event log
      const eventsText = (await panelPage.locator("#events-body").textContent()) ?? "";
      expect(eventsText).toContain("10129");
      expect(eventsText).toContain("Program stopped");

      // 5. Read RAPID symbol (BASE/tool0)
      await panelPage.click("#read-symbol-btn");
      const symOut = panelPage.locator("#symbol-output");
      await expect
        .poll(async () => await symOut.textContent(), { timeout: 10_000 })
        .toContain("T_ROB1/BASE/tool0");
      expect((await symOut.textContent()) ?? "").toContain("[TRUE,[[0,0,0],[1,0,0,0]]");

      // 6. Verify ZERO write/motion buttons exist anywhere in panel DOM
      const interactiveTexts = await panelPage.evaluate(() =>
        Array.from(document.querySelectorAll("button, a, input[type='submit']")).map((el) =>
          (el.textContent || "").toLowerCase(),
        ),
      );
      const forbiddenWords = ["write", "escribir", "start", "arrancar", "stop", "parar", "load", "cargar", "reset"];
      for (const label of interactiveTexts) {
        for (const word of forbiddenWords) {
          expect(label).not.toContain(word);
        }
      }

      // 7. Capture screenshot for manual & visual verification
      await panelPage.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
      await panelPage.close();
    } finally {
      await context.close();
    }
  }, 30_000);
});
