import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDigestAuthorization, parseAuthenticateHeader, RwsClient, RwsError } from "../src/rws/index.js";
import { FileCookieStore } from "../src/rws/node-cookie-store.js";
import { FakeRwsServer } from "../src/testing/fake-rws-server.js";

describe("RwsClient against FakeRwsServer (RW 6.16 fixtures)", () => {
  let server: FakeRwsServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new FakeRwsServer();
    baseUrl = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("authenticates once via Digest MD5 qop=auth and reuses session cookie across calls", async () => {
    const client = new RwsClient({ baseUrl });

    const state = await client.getControllerState();
    expect(state.system?.name).toBe("IRB120_3_58");
    expect(state.system?.rwversion).toBe("6.16.3007");
    expect(state.panel.ctrlstate).toBe("guardstop");
    expect(state.panel.opmode).toBe("MANR");
    expect(state.panel.ctrlexecstate).toBe("stopped");
    expect(state.tasks[0]?.name).toBe("T_ROB1");

    const mods = await client.listModules("T_ROB1");
    expect(mods.modules).toEqual(["user", "BASE"]);

    const joints = await client.getJoints();
    expect(joints.jointsDeg).toEqual([0, 0, 0, 0, 0, 0]);

    const tcp = await client.getTcp();
    expect(tcp.x).toBe(374);
    expect(tcp.z).toBe(630);

    const events = await client.getEventLog(5);
    expect(events.events).toHaveLength(5);
    expect(events.events[0]?.code).toBe("10129");

    // 5 calls in getControllerState + listModules + getJoints + getTcp + getEventLog = 9 HTTP calls
    // Only 1 session created and 1 challenge issued because cookie ABBCX is reused
    expect(server.stats.sessionsCreated).toBe(1);
    expect(server.stats.challengesIssued).toBe(1);
    expect(server.stats.cookieHits).toBeGreaterThanOrEqual(8);
  });

  it("persists session cookie in FileCookieStore across RwsClient instances", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rws-cookie-test-"));
    try {
      const store1 = new FileCookieStore(tmpDir);
      const client1 = new RwsClient({ baseUrl, cookieStore: store1 });
      await client1.getPanelState();
      expect(server.stats.sessionsCreated).toBe(1);

      const store2 = new FileCookieStore(tmpDir);
      const client2 = new RwsClient({ baseUrl, cookieStore: store2 });
      const info = await client2.getSystemInfo();
      expect(info.name).toBe("IRB120_3_58");
      expect(server.stats.sessionsCreated).toBe(1);
      expect(server.stats.cookieHits).toBeGreaterThanOrEqual(3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("avoids RW6 'Too many sessions' exhaustion when cookies are kept (unlike uncookied clients)", async () => {
    server.maxSessions = 3;

    // 1. Client reusing session cookie completes 10 requests with 1 session slot
    const client = new RwsClient({ baseUrl });
    for (let i = 0; i < 10; i++) {
      const sys = await client.getSystemInfo();
      expect(sys.name).toBe("IRB120_3_58");
    }
    expect(server.stats.sessionsCreated).toBe(1);

    // 2. Raw requests that ignore Set-Cookie exhaust slots and receive HTTP 503 Too many sessions
    let hitLimit = false;
    for (let i = 0; i < 5; i++) {
      const c = await fetch(`${baseUrl}/rw/system`);
      const challenge = parseAuthenticateHeader(c.headers.get("www-authenticate")!);
      const digest = computeDigestAuthorization({
        username: "Default User",
        password: "robotics",
        method: "GET",
        uri: "/rw/system",
        challenge,
        nc: 1,
      });
      const authed = await fetch(`${baseUrl}/rw/system`, {
        headers: { Authorization: digest.header },
      });
      if (authed.status === 503) {
        const text = await authed.text();
        expect(text).toContain("Too many sessions 3/3");
        hitLimit = true;
        break;
      }
    }
    expect(hitLimit).toBe(true);
  });

  it("renews Digest nonce automatically when controller responds with stale=TRUE", async () => {
    const client = new RwsClient({ baseUrl });
    await client.getSystemInfo();

    // Clear in-memory cookie to force sending cached Digest nonce, then simulate stale=TRUE nonce
    (client as unknown as { cookies: Map<string, string> }).cookies.clear();
    server.forceNextStaleNonce();

    const op = await client.getPanelState();
    expect(op.opmode).toBe("MANR");
    expect(server.stats.staleChallenges).toBe(1);
  });

  it("aborts slow HTTP requests cleanly with TIMEOUT RwsError", async () => {
    const hangingServer = http.createServer((_req, _res) => {
      // Intentionally never respond
    });
    await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = hangingServer.address() as { port: number };
    try {
      const client = new RwsClient({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        timeoutMs: 80,
      });
      await expect(client.getSystemInfo()).rejects.toMatchObject({
        status: 408,
        rwsCode: "TIMEOUT",
      });
    } finally {
      await new Promise<void>((resolve) => hangingServer.close(() => resolve()));
    }
  });

  it("never responds to an HTTP Basic authentication challenge", async () => {
    server.authMode = "basic";
    const client = new RwsClient({ baseUrl });

    let caught: unknown;
    try {
      await client.getSystemInfo();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(RwsError);
    expect((caught as RwsError).rwsCode).toBe("BASIC_AUTH_REJECTED");
    // Only the initial unauthenticated GET hit the server; zero follow-up requests sent credentials
    expect(server.stats.requests).toBe(1);
  });

  it("returns structured RW6 errors for missing symbols and verifies RW7 route returns 404", async () => {
    const client = new RwsClient({ baseUrl });

    await expect(client.readRapidSymbol("BASE", "does_not_exist")).rejects.toMatchObject({
      status: 400,
      rwsCode: "-1073414146",
      rwsMessage: expect.stringContaining("Symbol not found"),
    });

    // Verify directly that RW7 modules route returns 404 on RW6
    const rw7Res = await fetch(`${baseUrl}/rw/rapid/tasks/T_ROB1/modules`, {
      headers: { Cookie: client.currentCookieHeader ?? "" },
    });
    expect(rw7Res.status).toBe(404);
  });

  it("enforces RW6 DI write restriction (-1073445881) while allowing DO write", async () => {
    const client = new RwsClient({ baseUrl });

    await expect(client.setSignal("DRV1BRAKEOK", 1)).rejects.toMatchObject({
      status: 400,
      rwsCode: "-1073445881",
    });

    await client.setSignal("DRV1TESTE2", 1);
    const updated = await client.readSignal("DRV1TESTE2");
    expect(updated.value).toBe("1");
  });

  it("detects RW6 loadmod silent 204 syntax failure via module list + event log check", async () => {
    const client = new RwsClient({ baseUrl });

    const broken = await client.loadModule({
      fileName: "BrokenDemo.mod",
      content: "MODULE BrokenDemo\n  SYNTAX_ERROR\nENDMODULE",
    });
    expect(broken.success).toBe(false);
    expect(broken.modules).not.toContain("BrokenDemo");
    expect(broken.events.some((ev) => ev.title === "Load error")).toBe(true);

    const good = await client.loadModule({
      fileName: "GoodDemo.mod",
      content: "MODULE GoodDemo\n  PROC main()\n  ENDPROC\nENDMODULE",
    });
    expect(good.success).toBe(true);
    expect(good.modules).toContain("GoodDemo");
  });
});
