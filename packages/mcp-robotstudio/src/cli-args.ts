import os from "node:os";
import path from "node:path";
import type { RwsProtocolDialect } from "./rws/dialect.js";
import { type PermissionScope, scopesFromFlags } from "./security.js";

export interface CliConfig {
  rwsUrl: string;
  username: string;
  password: string;
  task: string;
  dialect: RwsProtocolDialect;
  insecureTls: boolean;
  scopes: Set<PermissionScope>;
  auditLog: string;
  agent: string;
  timeoutMs: number;
  help: boolean;
  version: boolean;
}

const SCOPE_ARGS: Record<string, PermissionScope | "all"> = {
  "--allow-io-write": "io-write",
  "--allow-var-write": "var-write",
  "--allow-module-upload": "module-upload",
  "--allow-motion": "motion",
  "--allow-write": "all",
};

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv): CliConfig {
  const defaultIp = env.ROBOT_IP ?? "127.0.0.1";
  const defaultPort = env.RWS_PORT ?? "80";
  const cfg: CliConfig = {
    rwsUrl: env.RWS_URL ?? `http://${defaultIp}:${defaultPort}`,
    username: env.RWS_USER ?? "Default User",
    password: env.RWS_PASS ?? "robotics",
    task: env.RWS_TASK ?? "T_ROB1",
    dialect: "auto",
    insecureTls: false,
    scopes: new Set(),
    auditLog: env.MCP_RS_AUDIT_LOG ?? path.join(os.homedir(), ".mcp-robotstudio", "audit.jsonl"),
    agent: env.MCP_RS_AGENT ?? "mcp-client",
    timeoutMs: 10_000,
    help: false,
    version: false,
  };
  const flags: Partial<Record<PermissionScope | "all", boolean>> = {};
  const value = (arg: string, i: number, name: string): [string, number] => {
    if (arg.startsWith(`${name}=`)) return [arg.slice(name.length + 1), i];
    const next = argv[i + 1];
    if (next === undefined) throw new Error(`Missing value for ${name}`);
    return [next, i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const name = arg.split("=")[0]!;
    if (arg === "--help" || arg === "-h") cfg.help = true;
    else if (arg === "--version" || arg === "-v") cfg.version = true;
    else if (arg === "--insecure-tls") cfg.insecureTls = true;
    else if (SCOPE_ARGS[arg]) flags[SCOPE_ARGS[arg]!] = true;
    else if (name === "--rws-url") [cfg.rwsUrl, i] = value(arg, i, name);
    else if (name === "--rws-user") [cfg.username, i] = value(arg, i, name);
    else if (name === "--rws-pass") [cfg.password, i] = value(arg, i, name);
    else if (name === "--task") [cfg.task, i] = value(arg, i, name);
    else if (name === "--audit-log") [cfg.auditLog, i] = value(arg, i, name);
    else if (name === "--agent") [cfg.agent, i] = value(arg, i, name);
    else if (name === "--dialect") {
      let d: string;
      [d, i] = value(arg, i, name);
      if (d !== "auto" && d !== "rws1" && d !== "rws2") throw new Error(`--dialect must be auto, rws1 or rws2 (got ${d})`);
      cfg.dialect = d;
    } else if (name === "--timeout-ms") {
      let t: string;
      [t, i] = value(arg, i, name);
      const parsed = Number(t);
      if (Number.isFinite(parsed) && parsed > 0) cfg.timeoutMs = parsed;
    } else {
      throw new Error(`Unknown or incomplete CLI option: ${arg}`);
    }
  }
  cfg.scopes = scopesFromFlags(flags);
  return cfg;
}

