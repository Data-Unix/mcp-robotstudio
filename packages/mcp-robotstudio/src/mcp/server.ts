import fs from "node:fs";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { captureForensicBlackbox } from "../forensics.js";
import {
  confData,
  eulerZYX,
  inverseKinematics,
  nOrient,
  orientZYX,
  type Pose,
  parsePoseLiteral,
  type Quat,
} from "../kinematics/index.js";
import { diffModules } from "../rapid/diff.js";
import { validateRapidModule } from "../rapid/validator.js";
import { checkRecipeWrite } from "../recipes.js";
import { auditRspag } from "../rspag/audit.js";
import { nodeCodec } from "../rspag/node-codec.js";
import { RwsClient, RwsError } from "../rws/index.js";
import { AuditLog, type PermissionScope, SCOPE_FLAGS } from "../security.js";

// Same source as the CLI (src/ and dist/ are both two levels below package.json);
// the fallback is kept in lockstep by scripts/sync_version.py.
const pkg = createRequire(import.meta.url)("../../package.json") as { version?: string };
export const PACKAGE_VERSION = pkg.version ?? "0.2.0";

export interface McpRobotStudioServerOptions {
  rwsClient: RwsClient;
  /** Legacy alias: enables every write scope. */
  allowWrite?: boolean;
  /** Granular write scopes; default none (read-only). */
  scopes?: Iterable<PermissionScope>;
  auditLog?: AuditLog;
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
  "get_program_pointer",
  "get_speed_ratio",
  "get_user_privileges",
  "read_module_source",
  "diff_module_with_golden",
  "validate_rapid_offline",
  "capture_forensic_blackbox",
  "probe_reach_kinematics",
  "audit_rspag_package",
] as const;

export const SCOPED_TOOL_NAMES: Record<PermissionScope, readonly string[]> = {
  "io-write": ["write_io_signal"],
  "var-write": ["write_rapid_symbol"],
  "module-upload": ["load_module", "trigger_controller_backup"],
  motion: ["start_rapid", "stop_rapid", "reset_pp", "set_speed_ratio"],
};

export const WRITE_TOOL_NAMES = Object.values(SCOPED_TOOL_NAMES).flat();

type ToolResultPayload = Record<string, unknown>;

function okResult(payload: ToolResultPayload) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function failResult(payload: ToolResultPayload) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorPayload(err: unknown, extra: Record<string, unknown> = {}): ToolResultPayload {
  return err instanceof RwsError
    ? { error: true, status: err.status, code: err.rwsCode ?? null, message: err.rwsMessage ?? err.message, detail: err.message, ...extra }
    : { error: true, message: err instanceof Error ? err.message : String(err), ...extra };
}

const poseSchema = {
  x: z.number(),
  y: z.number(),
  z: z.number(),
  q: z.array(z.number()).length(4).optional().describe("Quaternion [q1,q2,q3,q4] (RAPID order w,x,y,z)"),
  euler: z.array(z.number()).length(3).optional().describe("Euler ZYX [z,y,x] in deg (OrientZYX order)"),
};

function poseFrom(p: { x: number; y: number; z: number; q?: number[]; euler?: number[] }): Pose {
  const rot = p.q ? (p.q as Quat) : p.euler ? orientZYX(p.euler[0]!, p.euler[1]!, p.euler[2]!) : ([0, 0, 1, 0] as Quat);
  return { trans: [p.x, p.y, p.z], rot };
}

function toolFrom(tool?: string): Pose | undefined {
  return tool ? parsePoseLiteral(tool.replace(/^\s*\[\s*(TRUE|FALSE)\s*,/i, "[")) : undefined;
}

export function createMcpRobotStudioServer(options: McpRobotStudioServerOptions): McpServer {
  const { rwsClient, serverName = "mcp-robotstudio", serverVersion = PACKAGE_VERSION } = options;
  const scopes = new Set<PermissionScope>(
    options.allowWrite ? (Object.keys(SCOPED_TOOL_NAMES) as PermissionScope[]) : (options.scopes ?? []),
  );
  const audit = options.auditLog ?? new AuditLog(undefined);

  const server = new McpServer({ name: serverName, version: serverVersion });

  /** Registers a tool with uniform error handling and audit logging. */
  function tool<S extends z.ZodRawShape>(
    name: string,
    scope: PermissionScope | "read",
    def: { title: string; description: string; inputSchema: S; destructive?: boolean },
    run: (args: z.infer<z.ZodObject<S>>) => Promise<{ payload: ToolResultPayload; failed?: boolean }>,
  ): void {
    server.registerTool(
      name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations:
          scope === "read"
            ? { readOnlyHint: true, idempotentHint: true, destructiveHint: false }
            : { readOnlyHint: false, destructiveHint: def.destructive ?? true },
      },
      (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          const { payload, failed } = await run(args);
          audit.record({ tool: name, scope, params: args, outcome: failed ? "error" : "ok", result: scope === "read" ? { keys: Object.keys(payload) } : payload });
          return failed ? failResult(payload) : okResult(payload);
        } catch (err) {
          const payload = errorPayload(err);
          audit.record({ tool: name, scope, params: args, outcome: "error", result: payload });
          return failResult(payload);
        }
      }) as never,
    );
  }

  // ---------------------------------------------------------------------------
  // Read-only tools (always exposed)
  // ---------------------------------------------------------------------------
  tool("get_controller_state", "read", {
    title: "Get Controller State",
    description: `Reads controller system info, motor state, operating mode, RAPID execution state and tasks (dialect: ${rwsClient.requestedDialect}).`,
    inputSchema: {},
  }, async () => ({ payload: { ...(await rwsClient.getControllerState()), dialect: rwsClient.dialect } }));

  tool("list_modules", "read", {
    title: "List RAPID Modules",
    description: "Lists loaded RAPID modules for a task (RWS 1.0: /rw/rapid/modules?task=..., RWS 2.0: /rw/rapid/tasks/<t>/modules).",
    inputSchema: { task: z.string().min(1).optional().describe("RAPID task name (default: client task, e.g. T_ROB1)") },
  }, async ({ task }) => ({ payload: { ...(await rwsClient.listModules(task)) } }));

  tool("read_rapid_symbol", "read", {
    title: "Read RAPID Symbol",
    description: "Reads a RAPID variable/constant/persistent symbol value.",
    inputSchema: {
      module: z.string().min(1).describe("RAPID module name (e.g. BASE)"),
      symbol: z.string().min(1).describe("RAPID symbol name (e.g. tool0)"),
      task: z.string().min(1).optional().describe("RAPID task name (default: T_ROB1)"),
    },
  }, async ({ module, symbol, task }) => ({ payload: { ...(await rwsClient.readRapidSymbol(module, symbol, task)) } }));

  tool("list_signals", "read", {
    title: "List I/O Signals",
    description: "Lists controller I/O signals via /rw/iosystem/signals with optional substring filter and item limit.",
    inputSchema: {
      filter: z.string().optional().describe("Case-insensitive substring filter on signal name"),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum signals to return (default: 100)"),
    },
  }, async ({ filter, limit }) => {
    const result = await rwsClient.listSignals(filter ?? "", limit ?? 100);
    return { payload: { ...result, count: result.signals.length } };
  });

  tool("read_signal", "read", {
    title: "Read I/O Signal",
    description: "Reads a single I/O signal state and value from /rw/iosystem/signals/<name>.",
    inputSchema: { name: z.string().min(1).describe("I/O signal name (e.g. DRV1TESTE2)") },
  }, async ({ name }) => ({ payload: { signal: await rwsClient.readSignal(name) } }));

  tool("get_event_log", "read", {
    title: "Get Controller Event Log",
    description: "Reads recent controller event log entries from /rw/elog/<domain>.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe("Number of entries (default: 10)"),
      domain: z.number().int().min(0).max(20).optional().describe("Event log domain (default: 0 = Common)"),
    },
  }, async ({ limit, domain }) => {
    const result = await rwsClient.getEventLog(limit ?? 10, domain ?? 0);
    return { payload: { ...result, count: result.events.length } };
  });

  tool("get_joints", "read", {
    title: "Get Robot Joints",
    description: "Reads current joint angles (rax_1..rax_6 and external axes) from RWS motionsystem.",
    inputSchema: { mechunit: z.string().min(1).optional().describe("Mechanical unit name (default: ROB_1)") },
  }, async ({ mechunit }) => ({ payload: { ...(await rwsClient.getJoints(mechunit ?? "ROB_1")) } }));

  tool("get_tcp", "read", {
    title: "Get Robot TCP",
    description: "Reads current Cartesian TCP robtarget (x, y, z, quaternion, configuration) from RWS motionsystem.",
    inputSchema: {
      tool: z.string().min(1).optional().describe("Tool name (default: tool0)"),
      wobj: z.string().min(1).optional().describe("Work object name (default: wobj0)"),
      mechunit: z.string().min(1).optional().describe("Mechanical unit name (default: ROB_1)"),
    },
  }, async ({ tool: t, wobj, mechunit }) => ({ payload: { ...(await rwsClient.getTcp(t ?? "tool0", wobj ?? "wobj0", mechunit ?? "ROB_1")) } }));

  tool("get_program_pointer", "read", {
    title: "Get Program Pointer",
    description: "Reads /rw/rapid/tasks/<task>/pcp: module, routine and line/column of the program pointer (PP) and motion pointer (MP). With PP not set RW6 returns error -1073442809.",
    inputSchema: { task: z.string().min(1).optional() },
  }, async ({ task }) => ({ payload: { ...(await rwsClient.getProgramPointer(task)) } }));

  tool("get_speed_ratio", "read", {
    title: "Get Speed Ratio",
    description: "Reads /rw/panel/speedratio (0..100 %) and the cycle-time penalty factor 100/ratio.",
    inputSchema: {},
  }, async () => {
    const { speedRatio } = await rwsClient.getSpeedRatio();
    return { payload: { speedRatio, cycleTimeFactor: speedRatio ? 100 / speedRatio : null } };
  });

  tool("get_user_privileges", "read", {
    title: "Get UAS Privileges",
    description: "Reads the logged-in RWS user (/users), remote mastership privilege (/users/rmmp) and UAS grants (/users/grants). Missing endpoints are reported, never guessed.",
    inputSchema: {},
  }, async () => ({ payload: { ...(await rwsClient.getUserPrivileges()), enabledScopes: [...scopes] } }));

  tool("read_module_source", "read", {
    title: "Read Live Module Source",
    description: "Extracts the module text from controller RAM: action=save to TEMP (never HOME), downloads it via fileservice and deletes the temporary file.",
    inputSchema: { module: z.string().min(1), task: z.string().min(1).optional() },
  }, async ({ module, task }) => ({ payload: { ...(await rwsClient.readModuleSource(module, task)) } }));

  tool("diff_module_with_golden", "read", {
    title: "Diff Live Module vs Golden Master",
    description: "Line-by-line diff (LCS) between the live module in controller RAM and a Golden Master .mod (path or content).",
    inputSchema: {
      module: z.string().min(1),
      goldenPath: z.string().optional().describe("Local path to the Golden Master .mod"),
      goldenContent: z.string().optional(),
      ignoreWhitespace: z.boolean().optional(),
      task: z.string().min(1).optional(),
    },
  }, async ({ module, goldenPath, goldenContent, ignoreWhitespace, task }) => {
    const golden = goldenContent ?? (goldenPath ? fs.readFileSync(goldenPath, "utf8") : undefined);
    if (golden === undefined) throw new Error("goldenPath or goldenContent is required");
    const live = await rwsClient.readModuleSource(module, task);
    const d = diffModules(golden, live.source, { ignoreWhitespace: ignoreWhitespace ?? true });
    return { payload: { module, identical: d.identical, added: d.added, removed: d.removed, unified: d.unified } };
  });

  tool("validate_rapid_offline", "read", {
    title: "Validate RAPID Offline",
    description: "Offline RAPID checks: identifiers, unclosed MODULE/PROC/TRAP/IF/FOR/WHILE, non-unit quaternions, StorePath without StopMove, CONNECT without IDelete and (optional) IRB 120 reach of robtargets and Offs.",
    inputSchema: {
      content: z.string().optional(),
      path: z.string().optional(),
      checkReach: z.boolean().optional(),
      tool: z.string().optional().describe("tooldata or pose literal, e.g. [TRUE,[[31.8,0,229.6],[0.9455,0,0.3256,0]],...]"),
    },
  }, async ({ content, path: p, checkReach, tool: t }) => {
    const src = content ?? (p ? fs.readFileSync(p, "utf8") : undefined);
    if (src === undefined) throw new Error("content or path is required");
    const r = validateRapidModule(src, { checkReach: checkReach ?? false, tool: toolFrom(t) });
    return { payload: { ...r }, failed: !r.ok };
  });

  tool("capture_forensic_blackbox", "read", {
    title: "Capture Forensic Black Box",
    description: "Atomic snapshot at a stop: PCP + code around the PP line + I/O + last elog events + TCP + joints + speed ratio, cross-checked against known incidents. Returns JSON and Markdown.",
    inputSchema: {
      task: z.string().min(1).optional(),
      contextLines: z.number().int().min(0).max(30).optional(),
      signalFilter: z.string().optional(),
    },
  }, async (a) => ({ payload: { ...(await captureForensicBlackbox(rwsClient, a)) } }));

  tool("probe_reach_kinematics", "read", {
    title: "Probe Reach (offline IK)",
    description: "Evaluates reachability of a target and its Offs without moving the robot (offline IK of the IRB 120, same purpose as CalcJointT). Optionally sweeps tool tilt around X/Y to find a reachable orientation.",
    inputSchema: {
      ...poseSchema,
      tool: z.string().optional(),
      offsets: z.array(z.array(z.number()).length(3)).optional().describe("Offs to test, e.g. [[0,0,30],[0,0,-15]]"),
      tiltSweepDeg: z.array(z.number()).optional().describe("Tilt angles to try around X and Y, e.g. [0,10,20,30]"),
    },
  }, async (a) => {
    const base = poseFrom(a);
    const tl = toolFrom(a.tool);
    const tilts = a.tiltSweepDeg?.length ? a.tiltSweepDeg : [0];
    const variants: Array<Record<string, unknown>> = [];
    for (const tilt of tilts) {
      for (const axis of tilt === 0 ? ["none"] : ["x", "y"]) {
        const e = eulerZYX(base.rot);
        const rot = axis === "none" ? nOrient(base.rot) : axis === "x" ? orientZYX(e.z, e.y, e.x + tilt) : orientZYX(e.z, e.y + tilt, e.x);
        const results = [[0, 0, 0], ...(a.offsets ?? [])].map(([dx, dy, dz]) => {
          const ik = inverseKinematics({ trans: [base.trans[0] + dx!, base.trans[1] + dy!, base.trans[2] + dz!], rot }, { tool: tl });
          return {
            offs: [dx, dy, dz],
            reachable: ik.reachable,
            joints: ik.joints?.map((v) => Math.round(v * 100) / 100),
            conf: ik.joints ? confData(ik.joints) : undefined,
            wristSingular: ik.check?.wrist.singular,
            manipulabilityRel: ik.check ? Math.round(ik.check.manipulabilityRel * 1000) / 1000 : undefined,
          };
        });
        variants.push({ tiltDeg: tilt, axis, quaternion: rot.map((v) => Math.round(v * 1e6) / 1e6), allReachable: results.every((r) => r.reachable), results });
      }
    }
    const best = variants.find((v) => v.allReachable) ?? null;
    return { payload: { target: base, variants, best } };
  });

  tool("audit_rspag_package", "read", {
    title: "Audit .rspag Package",
    description: "Audits a Pack&Go: system.guid/template.guid per controller (anti 0x800706BA), backup taken from a folder copy, personal data (C:\\Users\\<name>, e-mail, blocklist), PNG metadata chunks and CRC.",
    inputSchema: { path: z.string().min(1), blocklist: z.array(z.string()).optional() },
  }, async ({ path: p, blocklist }) => {
    const r = await auditRspag(new Uint8Array(fs.readFileSync(p)), await nodeCodec(), { blocklist });
    return { payload: { ...r }, failed: r.verdict === "fail" };
  });

  // ---------------------------------------------------------------------------
  // Scoped write tools (registered only when their scope is enabled)
  // ---------------------------------------------------------------------------
  if (scopes.has("io-write")) {
    tool("write_io_signal", "io-write", {
      title: "Write / Pulse I/O Signal",
      description: `Sets an I/O signal (RWS 1.0 ?action=set, RWS 2.0 /set-value). pulseMs sets the value, waits and restores the previous value. Requires ${SCOPE_FLAGS["io-write"]}. DI without device are rejected by the controller.`,
      inputSchema: {
        name: z.string().min(1),
        value: z.union([z.string(), z.number()]),
        pulseMs: z.number().int().min(10).max(10_000).optional(),
      },
    }, async ({ name, value, pulseMs }) => {
      const before = pulseMs ? await rwsClient.readSignal(name) : undefined;
      const res = await rwsClient.setSignal(name, value);
      if (pulseMs && before) {
        await new Promise((r) => setTimeout(r, pulseMs));
        await rwsClient.setSignal(name, before.value ?? "0");
      }
      return { payload: { ...res, pulsed: Boolean(pulseMs), controllerChanges: `Signal ${name} set to ${res.value}${pulseMs ? ` for ${pulseMs} ms` : ""}` } };
    });
  }

  if (scopes.has("var-write")) {
    tool("write_rapid_symbol", "var-write", {
      title: "Write PERS Symbol (recipe shield)",
      description: `Writes a RAPID PERS symbol. Before writing: checks the symbol is PERS, then for robtarget/pose blocks non-unit quaternions, jumps above deltaMaxMm, points outside the IRB 120 envelope or unreachable; for num checks [numMin, numMax] and deltaMax. Requires ${SCOPE_FLAGS["var-write"]}.`,
      inputSchema: {
        module: z.string().min(1),
        symbol: z.string().min(1),
        value: z.string().min(1).describe("RAPID literal value (e.g. 42 or [[x,y,z],[q1,q2,q3,q4],...])"),
        task: z.string().min(1).optional(),
        deltaMaxMm: z.number().positive().optional().describe("max TCP jump (robtarget) or max change (num); default 50"),
        numMin: z.number().optional(),
        numMax: z.number().optional(),
        tool: z.string().optional(),
      },
    }, async ({ module, symbol, value, task, deltaMaxMm, numMin, numMax, tool: t }) => {
      const props = await rwsClient.getSymbolProperties(module, symbol, task);
      if (props.symtyp !== "per") {
        return { payload: { error: true, blocked: true, reason: `${module}/${symbol} is ${props.symtyp ?? "unknown"}, only PERS symbols can be written` }, failed: true };
      }
      const current = await rwsClient.readRapidSymbol(module, symbol, task).then((r) => r.value).catch(() => null);
      const shield = checkRecipeWrite(props.dattyp, current, value, { deltaMaxMm, numMin, numMax, tool: toolFrom(t) });
      if (!shield.allowed) {
        return { payload: { error: true, blocked: true, shield, controllerChanges: "none (blocked before writing)" }, failed: true };
      }
      const result = await rwsClient.writeRapidSymbol(module, symbol, value, task);
      return { payload: { ...result, previous: current, shield, controllerChanges: `Updated RAPID symbol ${result.task}/${result.module}/${result.symbol} to ${result.value}` } };
    });
  }

  if (scopes.has("module-upload")) {
    tool("load_module", "module-upload", {
      title: "Validate, Upload and Load RAPID Module",
      description: `Runs the offline validator first (aborts on errors), uploads the .mod to HOME, loads it under mastership and verifies /rw/rapid/modules and NEW /rw/elog/0 entries (RW6 answers 204 even on syntax errors). Requires ${SCOPE_FLAGS["module-upload"]}.`,
      inputSchema: {
        fileName: z.string().min(1),
        content: z.string().min(1),
        replace: z.boolean().optional(),
        task: z.string().min(1).optional(),
      },
    }, async ({ fileName, content, replace, task }) => {
      const offline = validateRapidModule(content);
      if (!offline.ok) {
        return { payload: { success: false, stage: "offline-validation", offline, controllerChanges: `none: ${fileName} failed offline validation and was not uploaded` }, failed: true };
      }
      const result = await rwsClient.loadModule({ fileName, content, replace, task });
      const home = rwsClient.routes.dirToken("HOME");
      return result.success
        ? { payload: { ...result, offlineWarnings: offline.warnings, controllerChanges: `Uploaded ${home}/${result.file} and verified module ${result.moduleName} loaded in task ${result.task}` } }
        : { payload: { ...result, controllerChanges: `Uploaded ${result.file} to ${home}, but module ${result.moduleName} failed to load into task ${result.task}` }, failed: true };
    });

    tool("trigger_controller_backup", "module-upload", {
      title: "Controller Backup to TEMP",
      description: `POST /ctrl/backup?action=backup into TEMP/<dir> only (never HOME); returns the /progress resource and optionally waits for it. Requires ${SCOPE_FLAGS["module-upload"]}.`,
      inputSchema: { dirName: z.string().min(1).max(32), waitMs: z.number().int().min(0).max(120_000).optional() },
      destructive: false,
    }, async ({ dirName, waitMs }) => {
      const r = await rwsClient.triggerBackup(dirName, waitMs ?? 0);
      return { payload: { ...r, controllerChanges: `Backup requested into ${r.backupPath}` } };
    });
  }

  if (scopes.has("motion")) {
    tool("start_rapid", "motion", {
      title: "Start RAPID Execution",
      description: `Starts RAPID execution (THE ROBOT MAY MOVE). Optionally resets the program pointer first. Requires ${SCOPE_FLAGS.motion}.`,
      inputSchema: {
        cycle: z.enum(["forever", "once", "asis"]).optional(),
        resetPp: z.boolean().optional(),
      },
    }, async ({ cycle, resetPp }) => {
      const result = await rwsClient.startRapid({ cycle, resetPp });
      return { payload: { ...result, controllerChanges: `Started RAPID execution (cycle=${result.cycle}, resetPp=${result.resetPp}); ctrlexecstate=${result.panel.ctrlexecstate ?? "unknown"}` } };
    });

    tool("stop_rapid", "motion", {
      title: "Stop RAPID Execution",
      description: `Stops RAPID execution. Requires ${SCOPE_FLAGS.motion}.`,
      inputSchema: {},
      destructive: false,
    }, async () => {
      const result = await rwsClient.stopRapid();
      return { payload: { ...result, controllerChanges: `Stopped RAPID execution; ctrlexecstate=${result.panel.ctrlexecstate ?? "unknown"}` } };
    });

    tool("reset_pp", "motion", {
      title: "Reset Program Pointer",
      description: `Moves the program pointer to main (resetpp, under RAPID mastership). Requires ${SCOPE_FLAGS.motion}.`,
      inputSchema: {},
    }, async () => {
      const r = await rwsClient.resetProgramPointer();
      const pcp = await rwsClient.getProgramPointer().catch(() => null);
      return { payload: { ...r, pcp, controllerChanges: "Program pointer reset to main" } };
    });

    tool("set_speed_ratio", "motion", {
      title: "Set Speed Ratio",
      description: `Sets /rw/panel/speedratio (0..100). Requires ${SCOPE_FLAGS.motion}.`,
      inputSchema: { ratio: z.number().int().min(0).max(100) },
    }, async ({ ratio }) => {
      const r = await rwsClient.setSpeedRatio(ratio);
      return { payload: { ...r, controllerChanges: `Speed ratio set to ${r.speedRatio}` } };
    });
  }

  return server;
}

export async function startStdioMcpServer(options: McpRobotStudioServerOptions): Promise<McpServer> {
  const server = createMcpRobotStudioServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
