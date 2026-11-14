# mcp-robotstudio

Real **ABB RobotWare 6 Robot Web Services (RWS 1.0)** client and **Model Context Protocol (MCP)** stdio server in TypeScript (Node >= 20 LTS, ESM, Apache-2.0).

Unlike mock/stub implementations, `mcp-robotstudio` communicates with real ABB IRC5 / Virtual Controllers (tested against RobotWare 6.16 fixtures) over HTTP Digest (`MD5`, `qop="auth"`), maintains the session cookie across requests, and strictly enforces read-only mode unless `--allow-write` is explicitly enabled.

## Highlights

- **Real RWS 1.0 client (`mcp-robotstudio/rws`)**:
  - RFC 7616 / RFC 2617 HTTP Digest `MD5` with `qop="auth"`, automatic `stale="TRUE"` nonce renewal, and `nc` counter tracking.
  - **Rejects HTTP Basic challenges** (`BASIC_AUTH_REJECTED`) so credentials never travel in clear base64 over HTTP.
  - Reuses the controller session cookie (`ABBCX` / `Set-Cookie`, persisted in `FileCookieStore` on Node) to prevent exhausting controller sessions (`Too many sessions 70/70`).
  - Parses ABB XHTML responses and extracts structured `<span class="code">` / `<span class="msg">` controller errors (`RwsError`).
  - Uses RobotWare 6 endpoints (including `/rw/rapid/modules?task=...`, avoiding the RW7-only path that returns 404 on RW6).
  - Pure Web Standards (`fetch`, `AbortController`) for the core RWS client so it runs identically in Node >= 20 and Chrome Extensions (MV3).
- **Safe-by-default MCP server (`mcp-robotstudio/mcp`)**:
  - Read-only by default: exposes **8 read-only tools**.
  - Write and execution tools (**4 tools**) are **not registered** in `tools/list` unless `--allow-write` is passed.
  - Every tool response returns both `content` (`text`) and an object `structuredContent` matching the MCP specification.
- **Zero native dependencies and no `postinstall` scripts**: pure TypeScript/ESM runtime (`@modelcontextprotocol/sdk` and `zod` only).

## Requirements

- Node.js `>= 20.0.0` (LTS 20 or 22 recommended)
- ABB IRC5 or RobotStudio Virtual Controller with RobotWare 6 (RWS 1.0)

## Finding the Virtual Controller RWS Port on Windows

RobotStudio Virtual Controllers (`RobVC`) can listen on dynamic ports or port `80`. Find the active listening port in PowerShell:

```powershell
$ids = (Get-Process RobVC).Id
Get-NetTCPConnection -State Listen | Where-Object { $ids -contains $_.OwningProcess }
```

## CLI Usage

Read-only mode (recommended):

```bash
npx mcp-robotstudio --rws-url http://127.0.0.1:<port>
```

With write/execution tools enabled (requires explicit confirmation of robot/controller changes):

```bash
npx mcp-robotstudio --rws-url http://127.0.0.1:<port> --allow-write
```

### CLI Options and Environment Variables

| Option | Env Variable | Default | Description |
|---|---|---|---|
| `--rws-url <url>` | `RWS_URL` (or `ROBOT_IP` + `RWS_PORT`) | `http://127.0.0.1:80` | Controller RWS base URL |
| `--rws-user <user>` | `RWS_USER` | `Default User` | RWS Digest username (virtual controller default) |
| `--rws-pass <pass>` | `RWS_PASS` | `robotics` | RWS Digest password (virtual controller default) |
| `--task <task>` | `RWS_TASK` | `T_ROB1` | Default RAPID task name |
| `--allow-write` | — | `false` | Expose write/execution MCP tools |
| `--timeout-ms <ms>` | — | `10000` | Per-request HTTP timeout |
| `-v, --version` | — | — | Print package version and exit |
| `-h, --help` | — | — | Show CLI help |

## MCP Tools

### Read-Only Tools (Always Available)

| Tool | Inputs | Description |
|---|---|---|
| `get_controller_state` | — | System info (`rwversion`, `name`, options), `ctrlstate`, `opmode`, `ctrlexecstate`, `cycle`, and RAPID tasks |
| `list_modules` | `task?` | Loaded RAPID modules via RW6 `/rw/rapid/modules?task=...` |
| `read_rapid_symbol` | `module`, `symbol`, `task?` | Reads RAPID variable/persistent/constant value |
| `list_signals` | `filter?`, `limit?` | Lists I/O signals (`/rw/iosystem/signals`) with optional substring filter |
| `read_signal` | `name` | Reads a single I/O signal state and value |
| `get_event_log` | `limit?`, `domain?` | Reads recent entries from `/rw/elog/<domain>` |
| `get_joints` | `mechunit?` | Reads current joint angles (`rax_1..rax_6`, external axes) |
| `get_tcp` | `tool?`, `wobj?`, `mechunit?` | Reads Cartesian TCP `robtarget` (`x, y, z`, quaternion, configuration) |

### Write / Execution Tools (Only Registered with `--allow-write`)

| Tool | Inputs | Description |
|---|---|---|
| `write_rapid_symbol` | `module`, `symbol`, `value`, `task?` | Updates a RAPID symbol (`?action=set`) and reports the change |
| `load_module` | `fileName`, `content`, `replace?`, `task?` | Uploads `.mod` to `$HOME`, acquires RAPID mastership, runs `loadmod`, then verifies module presence + event log (since RW6 returns HTTP 204 even on syntax errors) |
| `start_rapid` | `cycle?`, `resetPp?` | Starts RAPID execution (with optional `resetpp` first) and returns updated execution state |
| `stop_rapid` | — | Stops RAPID execution and returns updated execution state |

## Programmatic API

```ts
import { RwsClient, FileCookieStore } from "mcp-robotstudio";
import { createMcpRobotStudioServer } from "mcp-robotstudio/mcp";

const rws = new RwsClient({
  baseUrl: "http://127.0.0.1:80",
  username: "Default User",
  password: "robotics",
  cookieStore: new FileCookieStore(),
});

const state = await rws.getControllerState();
console.log(state.system?.rwversion, state.panel.ctrlstate);
```

## License

Apache-2.0 — see [LICENSE](./LICENSE).
