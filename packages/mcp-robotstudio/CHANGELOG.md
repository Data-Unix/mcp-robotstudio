# Changelog

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
