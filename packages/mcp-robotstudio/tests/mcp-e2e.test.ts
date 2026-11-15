import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { READ_ONLY_TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/mcp/server.js";
import { FakeRwsServer } from "../src/testing/fake-rws-server.js";

const CLI_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist/cli.js",
);

function assertValidMcpToolResponse(res: {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}): Record<string, unknown> {
  expect(Array.isArray(res.content)).toBe(true);
  expect(res.content.length).toBeGreaterThanOrEqual(1);
  expect(res.content[0]?.type).toBe("text");
  expect(typeof res.content[0]?.text).toBe("string");

  expect(res.structuredContent).toBeDefined();
  expect(res.structuredContent).not.toBeNull();
  expect(typeof res.structuredContent).toBe("object");
  expect(Array.isArray(res.structuredContent)).toBe(false);

  return res.structuredContent as Record<string, unknown>;
}

async function connectCliClient(args: string[]): Promise<{
  client: Client;
  transport: StdioClientTransport;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, ...args],
    stderr: "pipe",
  });
  const client = new Client(
    { name: "mcp-robotstudio-e2e-test", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

describe("MCP stdio E2E (dist/cli.js against FakeRwsServer)", () => {
  let server: FakeRwsServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new FakeRwsServer();
    baseUrl = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("exposes ONLY the 8 read-only tools by default and executes all 8 over stdio", async () => {
    const { client, transport } = await connectCliClient(["--rws-url", baseUrl]);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual([...READ_ONLY_TOOL_NAMES].sort());
      for (const writeName of WRITE_TOOL_NAMES) {
        expect(names).not.toContain(writeName);
      }

      // Calling an unregistered write tool must fail cleanly
      const blocked = await client.callTool({
        name: "write_rapid_symbol",
        arguments: { module: "EGM_Controller", symbol: "n_mcp_command", value: "99" },
      });
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked.content)).toContain("write_rapid_symbol");

      // 1. get_controller_state
      const stateRes = await client.callTool({ name: "get_controller_state", arguments: {} });
      expect(stateRes.isError).not.toBe(true);
      const stateData = assertValidMcpToolResponse(
        stateRes as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect((stateData.system as { name: string }).name).toBe("IRB120_3_58");
      expect((stateData.panel as { ctrlstate: string; opmode: string }).ctrlstate).toBe("guardstop");

      // 2. list_modules
      const modRes = await client.callTool({ name: "list_modules", arguments: { task: "T_ROB1" } });
      const modData = assertValidMcpToolResponse(
        modRes as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect(modData.modules).toEqual(["user", "BASE"]);

      // 3. read_rapid_symbol
      const symRes = await client.callTool({
        name: "read_rapid_symbol",
        arguments: { module: "BASE", symbol: "tool0" },
      });
      const symData = assertValidMcpToolResponse(
        symRes as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect(symData.value).toContain("[TRUE,[[0,0,0]");

      // 4. list_signals
      const sigListRes = await client.callTool({
        name: "list_signals",
        arguments: { filter: "DRV1" },
      });
      const sigListData = assertValidMcpToolResponse(
        sigListRes as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect(sigListData.count).toBe(5);

      // 5. read_signal
      const sigRes = await client.callTool({
        name: "read_signal",
        arguments: { name: "DRV1TESTE2" },
      });
      const sigData = assertValidMcpToolResponse(
        sigRes as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect((sigData.signal as { name: string; type: string }).name).toBe("DRV1TESTE2");

      // 6. get_event_log
      const elogRes = await client.callTool({
        name: "get_event_log",
        arguments: { limit: 4 },
      });
      const elogData = assertValidMcpToolResponse(
        elogRes as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect(elogData.count).toBe(4);

      // 7. get_joints
      const jointsRes = await client.callTool({ name: "get_joints", arguments: {} });
      const jointsData = assertValidMcpToolResponse(
        jointsRes as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect(jointsData.jointsDeg).toEqual([0, 0, 0, 0, 0, 0]);

      // 8. get_tcp
      const tcpRes = await client.callTool({ name: "get_tcp", arguments: {} });
      const tcpData = assertValidMcpToolResponse(
        tcpRes as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect(tcpData.x).toBe(374);
      expect(tcpData.z).toBe(630);
    } finally {
      await transport.close();
    }
  });

  it("runs the v0.2.0 read tools over stdio and wires --allow-io-write + --audit-log", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-rs-e2e-"));
    const logFile = path.join(dir, "audit.jsonl");
    server.defineModule("Golden", "MODULE Golden\n  CONST num A:=1;\n  PROC main()\n  ENDPROC\nENDMODULE\n");
    server.pcp = { module: "Golden", routine: "main", line: 3, column: 3 };
    const { client, transport } = await connectCliClient(["--rws-url", baseUrl, "--allow-io-write", "--audit-log", logFile, "--agent", "e2e"]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as Parameters<typeof assertValidMcpToolResponse>[0];
      return { data: assertValidMcpToolResponse(res), isError: res.isError };
    };
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("write_io_signal");
      expect(names).not.toContain("start_rapid");

      expect((await call("get_program_pointer")).data.programPointer).toMatchObject({ module: "Golden", routine: "main", beginLine: 3 });
      expect((await call("get_speed_ratio")).data).toMatchObject({ speedRatio: 100, cycleTimeFactor: 1 });
      expect((await call("get_user_privileges")).data).toMatchObject({ users: ["Default User"], enabledScopes: ["io-write"] });
      expect(String((await call("read_module_source", { module: "Golden" })).data.source)).toContain("CONST num A:=1;");
      const diff = (await call("diff_module_with_golden", { module: "Golden", goldenContent: "MODULE Golden\n  CONST num A:=2;\n  PROC main()\n  ENDPROC\nENDMODULE\n" })).data;
      expect(diff).toMatchObject({ identical: false, added: 1, removed: 1 });
      const bad = await call("validate_rapid_offline", { content: "MODULE X\n  PROC main()\nENDMODULE" });
      expect(bad.isError).toBe(true);
      const reach = (await call("probe_reach_kinematics", { x: 1100, y: 0, z: 300, offsets: [[0, 0, 30]], tiltSweepDeg: [0, 20] })).data;
      expect(reach.best).toBeNull();
      const reach2 = (await call("probe_reach_kinematics", { x: 340, y: 90, z: 205, q: [0, 0, 1, 0], offsets: [[0, 0, 30]], tool: "[TRUE,[[31.792631019,0,229.638935148],[0.945518576,0,0.325568154,0]],[1,[0,0,1],[1,0,0,0],0,0,0]]" })).data;
      expect((reach2.best as { allReachable: boolean }).allReachable).toBe(true);
      const rspag = path.resolve(path.dirname(CLI_PATH), "../../../practicas/6.3-colisiones-interrupciones/entregables/Practica63_Final.rspag");
      if (fs.existsSync(rspag)) expect((await call("audit_rspag_package", { path: rspag })).data.verdict).toBe("ok");
      const forensic = (await call("capture_forensic_blackbox", { contextLines: 1 })).data;
      expect((forensic.codeSnippet as { pointerLine: number }).pointerLine).toBe(3);
      expect(String(forensic.markdown)).toContain("Informe forense");
      const io = await call("write_io_signal", { name: "DRV1TESTE2", value: 1, pulseMs: 20 });
      expect(io.data).toMatchObject({ pulsed: true, success: true });
    } finally {
      await transport.close();
    }
    const log = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { tool: string; agent: string });
    expect(log.length).toBeGreaterThanOrEqual(10);
    expect(log.every((l) => l.agent === "e2e")).toBe(true);
    expect(log.at(-1)?.tool).toBe("write_io_signal");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exposes write tools only with --allow-write and reports controller changes", async () => {
    const { client, transport } = await connectCliClient([
      "--rws-url",
      baseUrl,
      "--allow-write",
    ]);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      expect(names).toEqual([...READ_ONLY_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort());

      // write_rapid_symbol -> verify updated value with read_rapid_symbol
      const writeRes = await client.callTool({
        name: "write_rapid_symbol",
        arguments: { module: "EGM_Controller", symbol: "n_mcp_command", value: "42" },
      });
      expect(writeRes.isError).not.toBe(true);
      const writeData = assertValidMcpToolResponse(
        writeRes as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect(String(writeData.controllerChanges)).toContain("n_mcp_command");

      const checkSym = await client.callTool({
        name: "read_rapid_symbol",
        arguments: { module: "EGM_Controller", symbol: "n_mcp_command" },
      });
      const checkSymData = assertValidMcpToolResponse(
        checkSym as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect(checkSymData.value).toBe("42");

      // load_module with syntax error returns isError=true + controllerChanges + event evidence
      const badLoad = await client.callTool({
        name: "load_module",
        arguments: {
          fileName: "FailMod.mod",
          content: "MODULE FailMod\n  SYNTAX_ERROR\nENDMODULE",
        },
      });
      expect(badLoad.isError).toBe(true);
      const badLoadData = assertValidMcpToolResponse(
        badLoad as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect(badLoadData.success).toBe(false);
      expect(String(badLoadData.controllerChanges)).toContain("failed to load");

      // load_module with valid RAPID succeeds and lists new module
      const goodLoad = await client.callTool({
        name: "load_module",
        arguments: {
          fileName: "OkMod.mod",
          content: "MODULE OkMod\n  PROC main()\n  ENDPROC\nENDMODULE",
        },
      });
      expect(goodLoad.isError).not.toBe(true);
      const goodLoadData = assertValidMcpToolResponse(
        goodLoad as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect(goodLoadData.success).toBe(true);
      expect(goodLoadData.modules).toContain("OkMod");

      // start_rapid + stop_rapid
      const startRes = await client.callTool({
        name: "start_rapid",
        arguments: { cycle: "once", resetPp: true },
      });
      expect(startRes.isError).not.toBe(true);
      const startData = assertValidMcpToolResponse(
        startRes as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect(String(startData.controllerChanges)).toContain("ctrlexecstate=running");

      const stopRes = await client.callTool({ name: "stop_rapid", arguments: {} });
      expect(stopRes.isError).not.toBe(true);
      const stopData = assertValidMcpToolResponse(
        stopRes as Parameters<typeof assertValidMcpToolResponse>[0],
      );
      expect(String(stopData.controllerChanges)).toContain("ctrlexecstate=stopped");
    } finally {
      await transport.close();
    }
  });
});
