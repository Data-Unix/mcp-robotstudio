#!/usr/bin/env node
import { createRequire } from "node:module";
import { startStdioMcpServer } from "./mcp/server.js";
import { RwsClient } from "./rws/client.js";
import { FileCookieStore } from "./rws/node-cookie-store.js";
import { parseCliArgs } from "./cli-args.js";
import { AuditLog } from "./security.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };
const VERSION = pkg.version ?? "0.2.0";

function printHelp(): void {
  process.stderr.write(`mcp-robotstudio v${VERSION} - ABB Robot Web Services MCP server (stdio), RWS 1.0 + RWS 2.0

Usage:
  npx mcp-robotstudio --rws-url http://127.0.0.1:<port> [scopes]

Connection:
  --rws-url <url>        Controller base URL (default: env RWS_URL or http://ROBOT_IP:RWS_PORT -> http://127.0.0.1:80)
  --rws-user <user>      Username (default: env RWS_USER or "Default User")
  --rws-pass <pass>      Password (default: env RWS_PASS or "robotics")
  --task <task>          RAPID task (default: env RWS_TASK or "T_ROB1")
  --dialect <d>          auto | rws1 (IRC5/RW6, Digest over HTTP) | rws2 (OmniCore/RW7-8, Basic over HTTPS). Default auto.
  --insecure-tls         Accept the self-signed factory certificate of an OmniCore controller (https only).
                         Disables certificate validation for this process: use only on a trusted cell network.
  --timeout-ms <ms>      HTTP timeout (default 10000)

Write scopes (default: read-only, no mutating tool is registered):
  --allow-io-write       write_io_signal (set / pulse)
  --allow-var-write      write_rapid_symbol (PERS only, recipe shield: delta_max, envelope, unit quaternion)
  --allow-module-upload  load_module (offline validator + anti false-204 check), trigger_controller_backup (TEMP only)
  --allow-motion         start_rapid, stop_rapid, reset_pp, set_speed_ratio
  --allow-write          alias: all four scopes

Audit:
  --audit-log <file>     Append-only hash-chained JSONL (default ~/.mcp-robotstudio/audit.jsonl, env MCP_RS_AUDIT_LOG)
  --agent <name>         Agent name written in each audit record (env MCP_RS_AGENT)

  -v, --version          Print version and exit
  -h, --help             Show this help

Find the virtual controller RWS port on Windows (PowerShell):
  $ids = (Get-Process RobVC).Id
  Get-NetTCPConnection -State Listen | Where-Object { $ids -contains $_.OwningProcess }
`);
}

async function main(): Promise<void> {
  const cfg = parseCliArgs(process.argv.slice(2), process.env);
  if (cfg.version) {
    process.stdout.write(`mcp-robotstudio v${VERSION}\n`);
    return;
  }
  if (cfg.help) {
    printHelp();
    return;
  }
  if (cfg.insecureTls) {
    if (!/^https:/i.test(cfg.rwsUrl)) throw new Error("--insecure-tls only applies to https:// URLs");
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const client = new RwsClient({
    baseUrl: cfg.rwsUrl,
    username: cfg.username,
    password: cfg.password,
    task: cfg.task,
    timeoutMs: cfg.timeoutMs,
    dialect: cfg.dialect,
    cookieStore: new FileCookieStore(),
  });
  const audit = new AuditLog(cfg.auditLog, cfg.agent, cfg.username);
  const scopes = [...cfg.scopes];

  process.stderr.write(
    `[mcp-robotstudio] v${VERSION} rws=${client.baseUrl} dialect=${cfg.dialect}->${client.dialect} task=${client.task} scopes=${scopes.length ? scopes.join(",") : "read-only"} audit=${cfg.auditLog}${cfg.insecureTls ? " TLS-VERIFY=OFF" : ""}\n`,
  );

  await startStdioMcpServer({ rwsClient: client, scopes, auditLog: audit, serverVersion: VERSION });
}

main().catch((err) => {
  process.stderr.write(`[mcp-robotstudio] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
