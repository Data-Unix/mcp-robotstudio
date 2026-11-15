# Changelog

## 0.2.0 - Unreleased

### Added

- Dual RWS client: `dialect` `auto` | `rws1` | `rws2` (`--dialect`). RWS 1.0 (IRC5/RW6): HTTP Digest MD5. RWS 2.0 (OmniCore/RW7-8): Basic over HTTPS only, `Accept: application/xhtml+xml;v=2.0`, path actions (`/rw/rapid/execution/start`), `edit` mastership, `HOME`/`TEMP` file roots. `auto` settles from the first 401 challenge. Basic over plain HTTP is still rejected; `--insecure-tls` accepts the controller's self-signed certificate.
- `RwsSubscriptionClient`: `POST /subscription` + WebSocket (`robapi2_subscription` / `rws_subscription`), ABB priority rules (priority 2 only for I/O signals and RAPID PERS, checked with symbol properties), initial snapshot from the 201 body, automatic fallback to polling.
- Granular write scopes: `--allow-io-write`, `--allow-var-write`, `--allow-module-upload`, `--allow-motion`; `--allow-write` enables all four. Read-only by default.
- Append-only, hash-chained JSONL audit log (`--audit-log`, `--agent`) with secret redaction and `verifyAuditLog`.
- Read tools: `get_program_pointer`, `get_speed_ratio`, `get_user_privileges`, `read_module_source`, `diff_module_with_golden`, `validate_rapid_offline`, `capture_forensic_blackbox`, `probe_reach_kinematics`, `audit_rspag_package`.
- Scoped tools: `write_io_signal` (io-write), PERS-only `write_rapid_symbol` with recipe shield (var-write), `load_module` with offline validation + `trigger_controller_backup` to TEMP (module-upload), `start_rapid`, `stop_rapid`, `reset_pp`, `set_speed_ratio` (motion).
- `mcp-robotstudio/kinematics`: IRB 120-3/0.58 forward kinematics (checked against the live controller), numeric IK, geometric Jacobian, Yoshikawa manipulability, wrist/elbow singularities, `OrientZYX`, `EulerZYX`, `NOrient`, `PoseMult`, `PoseInv`, `Offs`, `RelTool`.
- `mcp-robotstudio/rapid/validator`, `rapid/diff`, `recipes`, `forensics`, `rspag`, `practice` subpath exports (browser-safe).
- `FakeRwsServer`: RWS 2.0 mode over TLS, pcp, speed ratio, module save, backup, UAS, subscriptions and a dependency-free WebSocket server.

### Changed

- The elbow singularity of the IRB 120 is at q3 = -atan2(302, 70) = -76.95 deg (arm stretched), not q3 = 0 as the C++ filter assumed.

### Verified live on RobotWare 6.16.3007 (validation copy of Practica63_Final)

- `action=save` names: a 7-character name is saved as `<name>.mod`, longer names are cut to 7 characters; `read_module_source` lists TEMP to find the file.
- pcp: the program pointer uses `beginposition`/`modulemame`, the motion pointer `begposition`/`modulename`.
- PERS subscription events carry the value in a sibling `<li class="rap-data">`; `/rw/rapid/tasks/<task>/pcp;programpointerchange` is accepted.
- Backup only accepts `backup=/fileservice/$TEMP/<dir>`; `$TEMP/<dir>` (manual example) answers 400. Completion is read from `/ctrl/backup?action=backupstate` ("Backup Ready").

## 0.1.0 - Unreleased

### Added

- Pure TypeScript RWS 1.0 client (`mcp-robotstudio/rws`) for ABB RobotWare 6:
  - HTTP Digest `MD5` (`qop="auth"`) authentication with RFC 7616 support, nonce/opaque/nc reuse, and automatic `stale="TRUE"` handling.
  - Explicit rejection of HTTP Basic authentication (`BASIC_AUTH_REJECTED`).
  - Persistent session cookie support (`FileCookieStore` on Node, pluggable `CookieStore` interface for browsers/extensions).
  - XHTML/XML parsers verified against real RobotWare 6.16 captures.
  - Safe `loadModule` workflow validating module presence and `/rw/elog/0` after RW6's `204` response.
- Official MCP stdio server (`mcp-robotstudio/mcp`) built with `@modelcontextprotocol/sdk`:
  - 8 read-only tools registered by default (`get_controller_state`, `list_modules`, `read_rapid_symbol`, `list_signals`, `read_signal`, `get_event_log`, `get_joints`, `get_tcp`).
  - 4 write/execution tools (`write_rapid_symbol`, `load_module`, `start_rapid`, `stop_rapid`) exposed strictly behind `--allow-write`.
  - Structured JSON + text responses (`content` + object `structuredContent`).
- CLI binary `mcp-robotstudio` supporting `--rws-url`, `--rws-user`, `--rws-pass`, `--task`, `--allow-write`, `--timeout-ms`, and environment variables (`RWS_URL`, `ROBOT_IP`, `RWS_PORT`, `RWS_USER`, `RWS_PASS`, `RWS_TASK`).
- Reusable `FakeRwsServer` (`mcp-robotstudio/testing`) backed by captured RobotWare 6.16 fixtures for offline tests.
