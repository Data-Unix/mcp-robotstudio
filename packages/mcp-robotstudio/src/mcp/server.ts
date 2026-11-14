import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RwsClient, RwsError } from "../rws/index.js";

export interface McpRobotStudioServerOptions {
  rwsClient: RwsClient;
  allowWrite?: boolean;
  serverName?: string;
  serverVersion?: string;
}

export const READ_ONLY_TOOL_NAMES = [
  "get_controller_state",
  "list_modules",
  "read_rapid_symbol",
  "list_signals",
  "read_signal",
  "get_event_log",
  "get_joints",
  "get_tcp",
] as const;

export const WRITE_TOOL_NAMES = [
  "write_rapid_symbol",
  "load_module",
  "start_rapid",
  "stop_rapid",
] as const;

type ToolResultPayload = Record<string, unknown>;

function okResult(payload: ToolResultPayload) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(err: unknown, extra: Record<string, unknown> = {}) {
  const payload: ToolResultPayload =
    err instanceof RwsError
      ? {
          error: true,
          status: err.status,
          code: err.rwsCode ?? null,
          message: err.rwsMessage ?? err.message,
          detail: err.message,
          ...extra,
        }
      : {
          error: true,
          message: err instanceof Error ? err.message : String(err),
          ...extra,
        };

  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

export function createMcpRobotStudioServer(options: McpRobotStudioServerOptions): McpServer {
  const {
    rwsClient,
    allowWrite = false,
    serverName = "mcp-robotstudio",
    serverVersion = "0.1.0",
  } = options;

  const server = new McpServer({
    name: serverName,
    version: serverVersion,
  });

  // ---------------------------------------------------------------------------
  // Read-only tools (always exposed)
  // ---------------------------------------------------------------------------

  server.registerTool(
    "get_controller_state",
    {
      title: "Get Controller State",
      description:
        "Reads real ABB controller system info, motor state (ctrlstate), operating mode (opmode), RAPID execution state, and tasks via RWS 1.0.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const state = await rwsClient.getControllerState();
        return okResult({ ...state });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_modules",
    {
      title: "List RAPID Modules",
      description:
        "Lists loaded RAPID modules for a task using the RobotWare 6 endpoint (/rw/rapid/modules?task=...).",
      inputSchema: {
        task: z.string().min(1).optional().describe("RAPID task name (default: client task, e.g. T_ROB1)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async ({ task }) => {
      try {
        const result = await rwsClient.listModules(task);
        return okResult({ ...result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "read_rapid_symbol",
    {
      title: "Read RAPID Symbol",
      description:
        "Reads a RAPID variable/constant/persistent symbol value (/rw/rapid/symbol/data/RAPID/<task>/<module>/<symbol>).",
      inputSchema: {
        module: z.string().min(1).describe("RAPID module name (e.g. BASE or EGM_Controller)"),
        symbol: z.string().min(1).describe("RAPID symbol name (e.g. tool0 or s_mcp_status)"),
        task: z.string().min(1).optional().describe("RAPID task name (default: T_ROB1)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async ({ module, symbol, task }) => {
      try {
        const result = await rwsClient.readRapidSymbol(module, symbol, task);
        return okResult({ ...result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_signals",
    {
      title: "List I/O Signals",
      description:
        "Lists controller I/O signals via /rw/iosystem/signals with optional substring filter and item limit.",
      inputSchema: {
        filter: z.string().optional().describe("Case-insensitive substring filter on signal name"),
        limit: z.number().int().min(1).max(500).optional().describe("Maximum signals to return (default: 100)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async ({ filter, limit }) => {
      try {
        const result = await rwsClient.listSignals(filter ?? "", limit ?? 100);
        return okResult({ ...result, count: result.signals.length });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "read_signal",
    {
      title: "Read I/O Signal",
      description: "Reads a single I/O signal state and value from /rw/iosystem/signals/<name>.",
      inputSchema: {
        name: z.string().min(1).describe("I/O signal name (e.g. DRV1TESTE2)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async ({ name }) => {
      try {
        const signal = await rwsClient.readSignal(name);
        return okResult({ signal });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_event_log",
    {
      title: "Get Controller Event Log",
      description: "Reads recent controller event log entries from /rw/elog/<domain>.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe("Number of entries to retrieve (default: 10)"),
        domain: z.number().int().min(0).max(20).optional().describe("Event log domain (default: 0 = Common)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async ({ limit, domain }) => {
      try {
        const result = await rwsClient.getEventLog(limit ?? 10, domain ?? 0);
        return okResult({ ...result, count: result.events.length });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_joints",
    {
      title: "Get Robot Joints",
      description: "Reads current joint angles (rax_1..rax_6 and external axes) from RWS motionsystem.",
      inputSchema: {
        mechunit: z.string().min(1).optional().describe("Mechanical unit name (default: ROB_1)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async ({ mechunit }) => {
      try {
        const result = await rwsClient.getJoints(mechunit ?? "ROB_1");
        return okResult({ ...result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_tcp",
    {
      title: "Get Robot TCP",
      description: "Reads current Cartesian TCP robtarget (x, y, z, quaternion, configuration) from RWS motionsystem.",
      inputSchema: {
        tool: z.string().min(1).optional().describe("Tool name (default: tool0)"),
        wobj: z.string().min(1).optional().describe("Work object name (default: wobj0)"),
        mechunit: z.string().min(1).optional().describe("Mechanical unit name (default: ROB_1)"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    },
    async ({ tool, wobj, mechunit }) => {
      try {
        const result = await rwsClient.getTcp(tool ?? "tool0", wobj ?? "wobj0", mechunit ?? "ROB_1");
        return okResult({ ...result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Write tools (ONLY registered when --allow-write is explicitly enabled)
  // ---------------------------------------------------------------------------
  if (allowWrite) {
    server.registerTool(
      "write_rapid_symbol",
      {
        title: "Write RAPID Symbol",
        description:
          "Writes a value to a RAPID symbol on the controller (?action=set). Requires --allow-write.",
        inputSchema: {
          module: z.string().min(1).describe("RAPID module name"),
          symbol: z.string().min(1).describe("RAPID symbol name"),
          value: z.string().min(1).describe("RAPID literal value (e.g. 42, TRUE, or [[x,y,z],...])"),
          task: z.string().min(1).optional().describe("RAPID task name (default: T_ROB1)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ module, symbol, value, task }) => {
        try {
          const result = await rwsClient.writeRapidSymbol(module, symbol, value, task);
          return okResult({
            ...result,
            controllerChanges: `Updated RAPID symbol ${result.task}/${result.module}/${result.symbol} to ${result.value}`,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "load_module",
      {
        title: "Upload and Load RAPID Module",
        description:
          "Uploads a .mod file to controller $HOME, acquires RAPID mastership, invokes loadmod, and verifies both the module list and controller event log (because RW6 returns 204 even on syntax errors). Requires --allow-write.",
        inputSchema: {
          fileName: z.string().min(1).describe("Target filename under $HOME (e.g. DemoModule.mod)"),
          content: z.string().min(1).describe("Full RAPID module source code"),
          replace: z.boolean().optional().describe("Replace existing module with same name (default: true)"),
          task: z.string().min(1).optional().describe("RAPID task name (default: T_ROB1)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ fileName, content, replace, task }) => {
        try {
          const result = await rwsClient.loadModule({ fileName, content, replace, task });
          if (!result.success) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    {
                      ...result,
                      controllerChanges: `Uploaded ${result.file} to $HOME, but module ${result.moduleName} failed to load into task ${result.task}`,
                    },
                    null,
                    2,
                  ),
                },
              ],
              structuredContent: {
                ...result,
                controllerChanges: `Uploaded ${result.file} to $HOME, but module ${result.moduleName} failed to load into task ${result.task}`,
              },
            };
          }
          return okResult({
            ...result,
            controllerChanges: `Uploaded $HOME/${result.file} and verified module ${result.moduleName} loaded in task ${result.task}`,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "start_rapid",
      {
        title: "Start RAPID Execution",
        description:
          "Starts RAPID program execution on the controller (THE ROBOT MAY MOVE). Optionally resets program pointer to main first. Requires --allow-write.",
        inputSchema: {
          cycle: z
            .enum(["forever", "once", "asis"])
            .optional()
            .describe("Execution cycle mode (default: forever)"),
          resetPp: z
            .boolean()
            .optional()
            .describe("Reset program pointer to main before starting (default: false)"),
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      async ({ cycle, resetPp }) => {
        try {
          const result = await rwsClient.startRapid({ cycle, resetPp });
          return okResult({
            ...result,
            controllerChanges: `Started RAPID execution (cycle=${result.cycle}, resetPp=${result.resetPp}); ctrlexecstate=${result.panel.ctrlexecstate ?? "unknown"}`,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    );

    server.registerTool(
      "stop_rapid",
      {
        title: "Stop RAPID Execution",
        description: "Stops RAPID program execution on the controller. Requires --allow-write.",
        inputSchema: {},
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async () => {
        try {
          const result = await rwsClient.stopRapid();
          return okResult({
            ...result,
            controllerChanges: `Stopped RAPID execution; ctrlexecstate=${result.panel.ctrlexecstate ?? "unknown"}`,
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }

  return server;
}

export async function startStdioMcpServer(options: McpRobotStudioServerOptions): Promise<McpServer> {
  const server = createMcpRobotStudioServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
