#!/usr/bin/env node
import { createRequire } from "node:module";
import { startStdioMcpServer } from "./mcp/server.js";
import { RwsClient } from "./rws/client.js";
import { FileCookieStore } from "./rws/node-cookie-store.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };
const VERSION = pkg.version ?? "0.1.0";

interface CliConfig {
  rwsUrl: string;
  username: string;
  password: string;
  task: string;
  allowWrite: boolean;
  timeoutMs: number;
  help: boolean;
  version: boolean;
}

function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv): CliConfig {
  const defaultIp = env.ROBOT_IP ?? "127.0.0.1";
  const defaultPort = env.RWS_PORT ?? "80";
  let rwsUrl = env.RWS_URL ?? `http://${defaultIp}:${defaultPort}`;
  let username = env.RWS_USER ?? "Default User";
  let password = env.RWS_PASS ?? "robotics";
  let task = env.RWS_TASK ?? "T_ROB1";
  let allowWrite = false;
  let timeoutMs = 10_000;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--allow-write") {
      allowWrite = true;
    } else if (arg === "--rws-url" && argv[i + 1]) {
      rwsUrl = argv[++i]!;
    } else if (arg?.startsWith("--rws-url=")) {
      rwsUrl = arg.slice("--rws-url=".length);
    } else if (arg === "--rws-user" && argv[i + 1]) {
      username = argv[++i]!;
    } else if (arg?.startsWith("--rws-user=")) {
      username = arg.slice("--rws-user=".length);
    } else if (arg === "--rws-pass" && argv[i + 1]) {
      password = argv[++i]!;
    } else if (arg?.startsWith("--rws-pass=")) {
      password = arg.slice("--rws-pass=".length);
    } else if (arg === "--task" && argv[i + 1]) {
      task = argv[++i]!;
    } else if (arg?.startsWith("--task=")) {
      task = arg.slice("--task=".length);
    } else if (arg === "--timeout-ms" && argv[i + 1]) {
      const parsed = Number(argv[++i]);
      if (Number.isFinite(parsed) && parsed > 0) timeoutMs = parsed;
    } else if (arg?.startsWith("--timeout-ms=")) {
      const parsed = Number(arg.slice("--timeout-ms=".length));
      if (Number.isFinite(parsed) && parsed > 0) timeoutMs = parsed;
    } else {
      throw new Error(`Unknown or incomplete CLI option: ${arg}`);
    }
  }

  return {
    rwsUrl,
    username,
    password,
    task,
    allowWrite,
    timeoutMs,
    help,
    version,
  };
}

function printHelp(): void {
  process.stderr.write(`mcp-robotstudio v${VERSION} — Real RWS 1.0 MCP Server (stdio)

Usage:
  npx mcp-robotstudio --rws-url http://127.0.0.1:<port> [--allow-write]

Options:
  --rws-url <url>     Controller RWS base URL (default: env RWS_URL or http://ROBOT_IP:RWS_PORT -> http://127.0.0.1:80)
  --rws-user <user>   RWS Digest username (default: env RWS_USER or "Default User")
  --rws-pass <pass>   RWS Digest password (default: env RWS_PASS or "robotics")
  --task <task>       RAPID task name (default: env RWS_TASK or "T_ROB1")
  --allow-write       Expose write/execution tools (write_rapid_symbol, load_module, start_rapid, stop_rapid)
  --timeout-ms <ms>   HTTP request timeout in milliseconds (default: 10000)
  -v, --version       Print version and exit
  -h, --help          Show this help

How to find the virtual controller RWS port on Windows (PowerShell):
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

  const client = new RwsClient({
    baseUrl: cfg.rwsUrl,
    username: cfg.username,
    password: cfg.password,
    task: cfg.task,
    timeoutMs: cfg.timeoutMs,
    cookieStore: new FileCookieStore(),
  });

  process.stderr.write(
    `[mcp-robotstudio] v${VERSION} rws=${client.baseUrl} task=${client.task} mode=${cfg.allowWrite ? "READ+WRITE" : "READ-ONLY"}\n`,
  );

  await startStdioMcpServer({
    rwsClient: client,
    allowWrite: cfg.allowWrite,
    serverVersion: VERSION,
  });
}

main().catch((err) => {
  process.stderr.write(`[mcp-robotstudio] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
