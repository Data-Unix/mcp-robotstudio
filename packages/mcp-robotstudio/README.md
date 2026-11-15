# mcp-robotstudio

ABB **Robot Web Services** client (RWS 1.0 for IRC5 / RobotWare 6, RWS 2.0 for OmniCore / RobotWare 7-8) and **Model Context Protocol (MCP)** stdio server in TypeScript (Node >= 20, ESM, Apache-2.0).

It talks to real controllers. Everything marked "verified live" below was checked against a RobotWare 6.16 virtual controller (IRB 120-3/0.58); RWS 2.0 is covered by documentation and the bundled `FakeRwsServer` only.

## Highlights

- **RWS client (`mcp-robotstudio/rws`)**
  - Dialects `auto` | `rws1` | `rws2`. RWS 1.0: HTTP Digest MD5 (`qop="auth"`). RWS 2.0: Basic **only over HTTPS**, `Accept: application/xhtml+xml;v=2.0`, path actions, `edit` mastership, `HOME`/`TEMP` roots. `auto` decides from the URL scheme and the first 401 challenge.
  - Basic over plain HTTP is always rejected (`BASIC_AUTH_REJECTED`).
  - Reuses the session cookies (`-http-session-`, `ABBCX`) so the controller's 70-session limit is never hit.
  - WebSocket subscriptions (`robapi2_subscription` / `rws_subscription`) with ABB priority rules and automatic polling fallback. The WebSocket path needs Node >= 22 (global `WebSocket`); on Node 20 subscriptions use polling.
- **MCP server (`mcp-robotstudio/mcp`)**
  - Read-only by default: 17 read tools, 0 mutating tools.
  - Write tools are registered per scope: `--allow-io-write`, `--allow-var-write`, `--allow-module-upload`, `--allow-motion` (`--allow-write` = all four).
  - Every call is written to an append-only, hash-chained audit log.
- **Offline engineering libraries** (browser-safe subpath exports): IRB 120 kinematics, RAPID validator, line diff, recipe shield, forensic black box, `.rspag` audit/anonymizer, practice generator.

## CLI

```bash
npx mcp-robotstudio --rws-url http://127.0.0.1:<port>
```

```bash
npx mcp-robotstudio --rws-url https://<omnicore-ip> --dialect rws2 --insecure-tls
```

```bash
npx mcp-robotstudio --rws-url http://127.0.0.1:<port> --allow-var-write --allow-motion --audit-log ./audit.jsonl --agent claude-code
```

| Option | Env | Default | Description |
|---|---|---|---|
| `--rws-url <url>` | `RWS_URL` (or `ROBOT_IP` + `RWS_PORT`) | `http://127.0.0.1:80` | Controller base URL |
| `--rws-user <user>` | `RWS_USER` | `Default User` | Username |
| `--rws-pass <pass>` | `RWS_PASS` | `robotics` | Password |
| `--task <task>` | `RWS_TASK` | `T_ROB1` | RAPID task |
| `--dialect <d>` | - | `auto` | `auto`, `rws1`, `rws2` |
| `--insecure-tls` | - | off | Accept a self-signed certificate (https only). Disables certificate checks for the process. |
| `--allow-io-write` | - | off | `write_io_signal` |
| `--allow-var-write` | - | off | `write_rapid_symbol` (PERS only, recipe shield) |
| `--allow-module-upload` | - | off | `load_module`, `trigger_controller_backup` |
| `--allow-motion` | - | off | `start_rapid`, `stop_rapid`, `reset_pp`, `set_speed_ratio` |
| `--allow-write` | - | off | All four scopes |
| `--audit-log <file>` | `MCP_RS_AUDIT_LOG` | `~/.mcp-robotstudio/audit.jsonl` | Append-only audit log |
| `--agent <name>` | `MCP_RS_AGENT` | `mcp-client` | Agent name in each audit record |
| `--timeout-ms <ms>` | - | `10000` | HTTP timeout |

Find the virtual controller port on Windows:

```powershell
$ids = (Get-Process RobVC).Id
Get-NetTCPConnection -State Listen | Where-Object { $ids -contains $_.OwningProcess }
```

## MCP tools

### Read (always registered)

| Tool | What it does |
|---|---|
| `get_controller_state` | System, motors, mode, execution, tasks, dialect in use |
| `list_modules` | Loaded modules (RW6 `/rw/rapid/modules?task=`, RW7 `/rw/rapid/tasks/<t>/modules`) |
| `read_rapid_symbol` | Value of a RAPID symbol |
| `list_signals`, `read_signal` | I/O signals |
| `get_event_log` | `/rw/elog/<domain>` |
| `get_joints`, `get_tcp` | Joint target and robtarget |
| `get_program_pointer` | PP and MP: module, routine, line:column (verified live) |
| `get_speed_ratio` | Speed ratio and cycle-time factor 100/ratio |
| `get_user_privileges` | `/users`, `/users/rmmp`, `/users/grants` (UAS) |
| `read_module_source` | Module text from controller RAM: save to TEMP, read, delete (verified live) |
| `diff_module_with_golden` | Line diff between RAM and a Golden Master `.mod` |
| `validate_rapid_offline` | Identifiers, unclosed blocks, non-unit quaternions, StorePath without StopMove, CONNECT without IDelete, IRB 120 reach of robtargets and `Offs` |
| `capture_forensic_blackbox` | PP + code around it + I/O + elog + TCP + joints + speed, cross-checked with known incidents; JSON and Markdown |
| `probe_reach_kinematics` | Offline IK of a target and its `Offs`, optional tilt sweep; never moves the robot |
| `audit_rspag_package` | `system.guid`/`template.guid`, backup taken from a folder copy (0x800706BA), personal paths/e-mails, PNG metadata, CRC |

### Scoped (registered only with their flag)

| Scope | Tool | Notes |
|---|---|---|
| io-write | `write_io_signal` | Set or pulse; DI without device are rejected by the controller |
| var-write | `write_rapid_symbol` | PERS only; blocks non-unit quaternions, jumps above `deltaMaxMm`, points outside the envelope or unreachable |
| module-upload | `load_module` | Offline validation first, then upload, `loadmod` and a check of `/rw/rapid/modules` + new `/rw/elog/0` entries (RW6 answers 204 even with errors) |
| module-upload | `trigger_controller_backup` | Into TEMP only (`/fileservice/$TEMP/<dir>`, verified live) |
| motion | `start_rapid`, `stop_rapid`, `reset_pp`, `set_speed_ratio` | The robot may move |

## Programmatic API

```ts
import { RwsClient, FileCookieStore, RwsSubscriptionClient } from "mcp-robotstudio";

const rws = new RwsClient({ baseUrl: "http://127.0.0.1:80", cookieStore: new FileCookieStore() });
console.log((await rws.getProgramPointer()).programPointer);

const sub = new RwsSubscriptionClient({
  client: rws,
  resources: [{ uri: "/rw/iosystem/signals/ARRAY;state", priority: 2 }],
  onEvent: (e) => console.log(e.uri, e.values),
});
await sub.start();
```

## License

Apache-2.0, see [LICENSE](./LICENSE).
