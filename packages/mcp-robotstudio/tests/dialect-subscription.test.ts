import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildSubscriptionBody,
  isHighPriorityResource,
  RWS1_ROUTES,
  RWS2_ROUTES,
  RwsClient,
  RwsError,
  RwsSubscriptionClient,
  type SubscriptionEvent,
  validateSubscriptionPriority,
} from "../src/rws/index.js";
import { FakeRwsServer } from "../src/testing/fake-rws-server.js";

// The RWS 2.0 fake uses a self-signed certificate, exactly like an OmniCore out
// of the box; this is what --insecure-tls does in the CLI.
beforeAll(() => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
});

// Global WebSocket is stable from Node 22; on Node 20 subscriptions fall back to polling.
const HAS_WEBSOCKET = typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function";

const servers: FakeRwsServer[] = [];
async function startFake(opts: ConstructorParameters<typeof FakeRwsServer>[0] = {}) {
  const s = new FakeRwsServer(opts);
  servers.push(s);
  return { server: s, baseUrl: await s.start() };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("route table RWS 1.0 vs RWS 2.0", () => {
  it("translates every operation", () => {
    expect(RWS1_ROUTES.symbol("T_ROB1", "M", "s")).toBe("/rw/rapid/symbol/data/RAPID/T_ROB1/M/s");
    expect(RWS2_ROUTES.symbol("T_ROB1", "M", "s")).toBe("/rw/rapid/symbol/RAPID/T_ROB1/M/s/data");
    expect(RWS1_ROUTES.symbolSet("T_ROB1", "M", "s")).toMatch(/\?action=set$/);
    expect(RWS1_ROUTES.modules("T_ROB1")).toBe("/rw/rapid/modules?task=T_ROB1");
    expect(RWS2_ROUTES.modules("T_ROB1")).toBe("/rw/rapid/tasks/T_ROB1/modules");
    expect(RWS1_ROUTES.execution("start")).toBe("/rw/rapid/execution?action=start");
    expect(RWS2_ROUTES.execution("start")).toBe("/rw/rapid/execution/start");
    expect(RWS1_ROUTES.mastership("cfg", "request")).toBe("/rw/mastership/cfg?action=request");
    expect(RWS2_ROUTES.mastership("cfg", "request")).toBe("/rw/mastership/edit/request");
    expect(RWS2_ROUTES.mastership("rapid", "release")).toBe("/rw/mastership/edit/release");
    expect(RWS1_ROUTES.file("HOME", "a.mod")).toBe("/fileservice/$HOME/a.mod");
    expect(RWS2_ROUTES.file("HOME", "a.mod")).toBe("/fileservice/HOME/a.mod");
    expect(RWS1_ROUTES.subscriptionProtocol).toBe("robapi2_subscription");
    expect(RWS2_ROUTES.subscriptionProtocol).toBe("rws_subscription");
    expect(RWS2_ROUTES.accept).toContain("v=2.0");
    expect(RWS1_ROUTES.accept).toBeUndefined();
  });

  it("validates ABB subscription priorities", () => {
    expect(validateSubscriptionPriority("/rw/panel/ctrlstate", 2)).toMatch(/only allowed/);
    expect(validateSubscriptionPriority("/rw/rapid/execution;ctrlexecstate", 2)).toBeDefined();
    expect(validateSubscriptionPriority("/rw/elog/0", 2)).toBeDefined();
    expect(validateSubscriptionPriority("/rw/rapid/tasks/T_ROB1/pcp", 2)).toBeDefined();
    expect(validateSubscriptionPriority("/rw/panel/ctrlstate", 1)).toBeUndefined();
    expect(validateSubscriptionPriority("/rw/elog/0", 0)).toBeUndefined();
    expect(validateSubscriptionPriority("/rw/iosystem/signals/DRV1TESTE2;state", 2)).toBeUndefined();
    expect(isHighPriorityResource("/rw/rapid/symbol/data/RAPID/T_ROB1/M/n;value")).toBe(true);
    expect(validateSubscriptionPriority("/rw/panel/ctrlstate", 3)).toMatch(/0, 1 or 2/);
    expect(buildSubscriptionBody([{ uri: "/rw/panel/ctrlstate", priority: 1 }, { uri: "/rw/elog/0", priority: 0 }])).toBe(
      "resources=1&1=%2Frw%2Fpanel%2Fctrlstate&1-p=1&resources=2&2=%2Frw%2Felog%2F0&2-p=0",
    );
  });
});

describe("RWS 2.0 client against the HTTPS fake (Basic over TLS)", () => {
  it("auto-detects rws2 from https + Basic challenge, logs in once and uses OmniCore routes", async () => {
    const { server, baseUrl } = await startFake({ dialect: "rws2" });
    const client = new RwsClient({ baseUrl });
    expect(client.dialect).toBe("rws2");
    const sys = await client.getSystemInfo();
    expect(sys.name).toBe("IRB120_3_58");
    const mods = await client.listModules();
    expect(mods.modules).toContain("BASE");
    const sym = await client.readRapidSymbol("BASE", "tool0");
    expect(sym.value).toContain("[TRUE,[[0,0,0]");
    await client.writeRapidSymbol("EGM_Controller", "n_mcp_command", "7");
    expect((await client.readRapidSymbol("EGM_Controller", "n_mcp_command")).value).toBe("7");
    await client.startRapid({ cycle: "once" });
    expect((await client.getPanelState()).ctrlexecstate).toBe("running");
    await client.stopRapid();
    expect(server.stats.basicLogins).toBe(1);
    expect(server.requestLog.some((l) => l.includes("/rw/rapid/execution/start"))).toBe(true);
    expect(server.requestLog.some((l) => l.includes("?action="))).toBe(false);
    expect(server.requestLog.some((l) => l.includes("/rw/mastership/edit/"))).toBe(false); // start without resetpp needs no mastership
  });

  it("saves a module to TEMP (not $TEMP) and cleans up", async () => {
    const { server, baseUrl } = await startFake({ dialect: "rws2" });
    server.defineModule("Golden", "MODULE Golden\n  PROC main()\n  ENDPROC\nENDMODULE\n");
    const client = new RwsClient({ baseUrl });
    const src = await client.readModuleSource("Golden");
    expect(src.source).toContain("MODULE Golden");
    expect(src.tempFile).toMatch(/^TEMP\/mcp[0-9a-f]{4}\.mod$/);
    expect(server.tempFileNames).toEqual([]);
    expect(server.requestLog.some((l) => l.includes("/fileservice/TEMP/"))).toBe(true);
  });

  it("refuses rws2 on plain http and refuses Basic when forced to rws1", async () => {
    expect(() => new RwsClient({ baseUrl: "http://127.0.0.1:1", dialect: "rws2" })).toThrow(/https/);
    const { baseUrl } = await startFake({ dialect: "rws2" });
    const forced = new RwsClient({ baseUrl, dialect: "rws1" });
    await expect(forced.getSystemInfo()).rejects.toMatchObject({ rwsCode: "BASIC_AUTH_REJECTED" });
  });

  it("still rejects a Basic challenge over plain HTTP in auto mode", async () => {
    const { baseUrl } = await startFake({ authMode: "basic" });
    const client = new RwsClient({ baseUrl });
    await expect(client.getSystemInfo()).rejects.toBeInstanceOf(RwsError);
    await expect(client.getSystemInfo()).rejects.toMatchObject({ rwsCode: "BASIC_AUTH_REJECTED" });
  });

  it("the RWS 1.0 fake answers 404 to RWS 2.0 routes and vice versa", async () => {
    const { baseUrl } = await startFake();
    const c1 = new RwsClient({ baseUrl });
    await expect(c1.request("POST", "/rw/rapid/execution/start")).rejects.toMatchObject({ status: 404 });
    const { baseUrl: b2 } = await startFake({ dialect: "rws2" });
    const c2 = new RwsClient({ baseUrl: b2 });
    await expect(c2.request("POST", "/rw/rapid/execution?action=start")).rejects.toMatchObject({ status: 404 });
  });
});

describe("new RWS 1.0 reads and writes", () => {
  it("pcp, speed ratio, UAS, backup to TEMP only", async () => {
    const { server, baseUrl } = await startFake();
    const client = new RwsClient({ baseUrl });
    const pcp0 = await client.getProgramPointer();
    expect(pcp0.programPointer.errorCode).toBe("-1073442809");
    server.pcp = { module: "Practica63_Final", routine: "recorrer_array", line: 52, column: 9 };
    const pcp = await client.getProgramPointer();
    expect(pcp.programPointer).toMatchObject({ module: "Practica63_Final", routine: "recorrer_array", beginLine: 52, beginColumn: 9 });

    expect((await client.getSpeedRatio()).speedRatio).toBe(100);
    expect((await client.setSpeedRatio(25)).speedRatio).toBe(25);
    await expect(client.setSpeedRatio(150)).rejects.toMatchObject({ rwsCode: "INVALID_SPEED_RATIO" });

    const uas = await client.getUserPrivileges();
    expect(uas.users).toEqual(["Default User"]);
    expect(uas.rmmp?.privilege).toBe("none");
    expect(uas.grants).toContain("UAS_BACKUP");
    expect(uas.unavailable).toEqual([]);

    const b = await client.triggerBackup("bk_test", 2000);
    expect(b.statusCode).toBe(202);
    expect(b.backupPath).toBe("$TEMP/bk_test");
    expect(b.progress).toBe("/progress/1");
    expect(b.state).toBe("Backup Ready");
    await expect(client.triggerBackup("../HOME/x")).rejects.toMatchObject({ rwsCode: "INVALID_BACKUP_DIR" });
  });

  it("readModuleSource finds the file RW6 actually saved (<7 chars>.mod) and leaves TEMP empty", async () => {
    const { server, baseUrl } = await startFake();
    server.defineModule("Practica63_Final", "MODULE Practica63_Final\nENDMODULE\n");
    const client = new RwsClient({ baseUrl });
    const r = await client.readModuleSource("Practica63_Final");
    expect(r.source).toContain("MODULE Practica63_Final");
    expect(r.tempFile).toMatch(/^\$TEMP\/mcp[0-9a-f]{4}\.mod$/);
    expect(server.tempFileNames).toEqual([]);
  });
});

describe("RwsSubscriptionClient (WebSocket + fallback)", () => {
  for (const dialect of ["rws1", "rws2"] as const) {
    it.skipIf(!HAS_WEBSOCKET)(`${dialect}: negotiates ${dialect === "rws1" ? "robapi2_subscription" : "rws_subscription"} with the session cookie and receives events`, async () => {
      const { server, baseUrl } = await startFake({ dialect });
      const client = new RwsClient({ baseUrl });
      const events: SubscriptionEvent[] = [];
      const sub = new RwsSubscriptionClient({
        client,
        resources: [
          { uri: "/rw/iosystem/signals/DRV1TESTE2;state", priority: 2 },
          { uri: "/rw/rapid/execution;ctrlexecstate", priority: 1 },
        ],
        onEvent: (e) => events.push(e),
      });
      const started = await sub.start();
      expect(started.mode).toBe("websocket");
      expect(server.stats.wsUpgrades).toBe(1);
      // initial snapshot from the 201 body
      expect(events.some((e) => e.uri.endsWith("DRV1TESTE2;state") && e.values.lvalue === "0")).toBe(true);
      await client.setSignal("DRV1TESTE2", 1);
      await waitFor(() => events.some((e) => e.values.lvalue === "1" && e.source === "websocket"));
      await client.startRapid();
      await waitFor(() => events.some((e) => e.values.ctrlexecstate === "running"));
      await sub.stop();
      expect(sub.mode).toBe("closed");
    });
  }

  it("rejects priority 2 on ctrlstate before contacting the controller", async () => {
    const { server, baseUrl } = await startFake();
    const client = new RwsClient({ baseUrl });
    const sub = new RwsSubscriptionClient({ client, resources: [{ uri: "/rw/panel/ctrlstate", priority: 2 }], onEvent: () => undefined });
    await expect(sub.start()).rejects.toMatchObject({ rwsCode: "INVALID_PRIORITY" });
    expect(server.requestLog.some((l) => l.startsWith("POST /subscription"))).toBe(false);
  });

  it("rejects priority 2 on a CONST symbol (PERS check) and the fake controller does too", async () => {
    const { server, baseUrl } = await startFake();
    server.defineSymbol("T_ROB1/Practica63_Final/P_MATRIZ", "[[340,90,205],[0,0,1,0],[0,0,0,0],[9E9,9E9,9E9,9E9,9E9,9E9]]", "con", "robtarget");
    const client = new RwsClient({ baseUrl });
    const uri = "/rw/rapid/symbol/data/RAPID/T_ROB1/Practica63_Final/P_MATRIZ;value";
    const sub = new RwsSubscriptionClient({ client, resources: [{ uri, priority: 2 }], onEvent: () => undefined });
    await expect(sub.start()).rejects.toThrow(/PERS/);
    await expect(
      client.request("POST", "/subscription", { body: buildSubscriptionBody([{ uri, priority: 2 }]), contentType: "application/x-www-form-urlencoded" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.request("POST", "/subscription", { body: buildSubscriptionBody([{ uri: "/rw/panel/ctrlstate", priority: 2 }]), contentType: "application/x-www-form-urlencoded" }),
    ).rejects.toThrow(/Highpriority/);
  });

  it("falls back to polling when the WebSocket upgrade is blocked (or WebSocket is unavailable)", async () => {
    // also the Node 20 path, where there is no global WebSocket at all
    const { server, baseUrl } = await startFake({ blockWebSocket: true });
    const client = new RwsClient({ baseUrl });
    const events: SubscriptionEvent[] = [];
    const modes: string[] = [];
    const sub = new RwsSubscriptionClient({
      client,
      resources: [{ uri: "/rw/rapid/execution;ctrlexecstate", priority: 1 }],
      onEvent: (e) => events.push(e),
      onModeChange: (m) => modes.push(m),
      pollIntervalMs: 50,
    });
    const r = await sub.start();
    expect(r.mode).toBe("polling");
    // Node 20 has no global WebSocket: the client polls without attempting an upgrade.
    expect(server.stats.wsRejected).toBe(HAS_WEBSOCKET ? 1 : 0);
    await client.startRapid();
    await waitFor(() => events.some((e) => e.source === "polling" && e.values.ctrlexecstate === "running"));
    await sub.stop();
    expect(modes).toEqual(["polling", "closed"]);
  });

  it.skipIf(!HAS_WEBSOCKET)("a wrong subprotocol is refused by the fake (RW7 rejects the 1.0 name)", async () => {
    const { baseUrl } = await startFake({ dialect: "rws2" });
    const client = new RwsClient({ baseUrl });
    const res = await client.request("POST", "/subscription", {
      body: buildSubscriptionBody([{ uri: "/rw/panel/ctrlstate", priority: 1 }]),
      contentType: RWS2_ROUTES.formContentType,
    });
    const ws = new WebSocket(res.location!, { protocols: ["robapi2_subscription"], headers: { Cookie: client.currentCookieHeader } } as never);
    const outcome = await new Promise<string>((resolve) => {
      ws.onopen = () => resolve("open");
      ws.onerror = () => resolve("error");
    });
    expect(outcome).toBe("error");
  });
});
