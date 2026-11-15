# mcp-robotstudio

[![CI - Node Packages & Privacy Gate](https://github.com/Data-Unix/mcp-robotstudio/actions/workflows/ci.yml/badge.svg)](https://github.com/Data-Unix/mcp-robotstudio/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js >= 20 LTS](https://img.shields.io/badge/Node-%3E%3D20%20LTS-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio%20SDK-blue.svg)](https://modelcontextprotocol.io/)

Real **ABB RobotWare 6 (RWS 1.0) & OmniCore RobotWare 7-8 (RWS 2.0)** client with WebSocket subscriptions, **Model Context Protocol (MCP)** stdio server with granular write scopes, and **5-tab Manifest V3 Chrome Extension** (`FREE` + `PRO`) in TypeScript (Node `>= 20 LTS`, ESM, Apache-2.0).

---

## Packages & Repository Layout

| Path | Description |
|---|---|
| [`packages/mcp-robotstudio`](packages/mcp-robotstudio/README.md) | Public npm package: dual RWS 1.0/2.0 client (Digest MD5 over HTTP / Basic only over HTTPS, session cookie reuse, WebSocket subscriptions with polling fallback) + MCP stdio server (`17` read-only tools by default; scoped writes via `--allow-io-write`, `--allow-var-write`, `--allow-module-upload`, `--allow-motion`, or `--allow-write` = all four, plus hash-chained audit log) + CLI + `FakeRwsServer` |
| [`packages/chrome-extension`](packages/chrome-extension/README.md) | Manifest V3 Chrome side-panel & popup instrumentation (`01 TELEMETRIA Y CINEMATICA`, `02 FORENSE Y DIFF`, `03 OSCILOSCOPIO Y FLOTA`, `04 ALCANCE Y RECETAS`, `05 ESTUDIO DE PRACTICAS`), offscreen subscription host, local `.rspag` Web Worker, strict CSP, session-only credential storage |
| [`referencias/rws-rw6-fixtures`](referencias/rws-rw6-fixtures/README.md) | Anonymized RobotWare 6.16 HTTP & WebSocket fixtures used by `FakeRwsServer` for deterministic unit, MCP stdio E2E, and Chrome E2E verification |
| [`referencias/rws-test-tls`](referencias/rws-test-tls/README.md) | Test-only self-signed TLS certificate/key pair used offline by `FakeRwsServer({ dialect: "rws2" })` to simulate OmniCore HTTPS |
| [`scripts/check_privacy.py`](scripts/check_privacy.py) | Automated privacy gate & Pack&Go self-test executed in CI |
| [`scripts/anonymize_rspag.py`](scripts/anonymize_rspag.py) | Context-aware `.rspag` anonymizer that preserves binary blobs (`key.id`, geometry streams) and RAPID source identifiers |
| [`scripts/sync_version.py`](scripts/sync_version.py) | One version for the npm package, the GitHub Release and the Chrome extension: `--set X.Y.Z` writes it, `--check` fails on any mismatch (CI and release gate) |

---

## Security & Privacy Highlights

- **Dual RWS 1.0 / RWS 2.0 auth hardening**: RFC 7616 / RFC 2617 HTTP Digest MD5 (`qop="auth"`) on RWS 1.0, Basic auth accepted **only over HTTPS** on RWS 2.0 (`BASIC_AUTH_REJECTED` on plain HTTP) so credentials never travel in clear base64.
- **Persistent session cookie reuse (`-http-session-`, `ABBCX`)**: avoids exhausting the RobotWare `70/70` controller session limit.
- **Read-only by default + granular scopes**: `17` read-only tools registered by default; mutating/execution tools are registered only when their explicit scope flag (`--allow-io-write`, `--allow-var-write`, `--allow-module-upload`, `--allow-motion`, or `--allow-write`) is supplied, and every call is recorded in an append-only SHA-256 hash-chained audit log (`--audit-log`).
- **MV3 Extension hardening**: read-only by default (writes gated by local ECDSA PRO licence + session write mode, zero motion calls in the extension bundle verified in CI), zero `content_scripts`, zero remote hosted code, secrets stored strictly in `chrome.storage.session` (`TRUSTED_CONTEXTS`), audited in [SECURITY_REVIEW.md](packages/chrome-extension/SECURITY_REVIEW.md) and [PRIVACY_POLICY.md](packages/chrome-extension/PRIVACY_POLICY.md).
- **Zero native dependencies / zero `postinstall` scripts** in runtime packages.

---

## Quick Start

### 1. Build and Run All Tests Offline (Against Real RobotWare 6.16 Fixtures)

```bash
cd packages
npm ci
npm run build
npm run lint
npm run typecheck
npm test
npm pack --dry-run -w mcp-robotstudio
npm audit --omit=dev --audit-level=high
python3 ../scripts/check_privacy.py --self-test
```

### 2. Find the RobotStudio Virtual Controller Port (`RobVC`) on Windows

```powershell
$ids = (Get-Process RobVC).Id
Get-NetTCPConnection -State Listen | Where-Object { $ids -contains $_.OwningProcess }
```

### 3. Run the MCP Server (Read-Only Default)

```bash
npx mcp-robotstudio --rws-url http://127.0.0.1:<port> --rws-user "Default User" --rws-pass robotics
```

Enable controller write/execution tools only when intentionally operating in a supervised environment:

```bash
npx mcp-robotstudio --rws-url http://127.0.0.1:<port> --allow-write
```

### 4. Load the Chrome Extension Locally

1. Run `npm ci && npm run build` inside `packages/`.
2. Open `chrome://extensions/`, enable **Developer mode**, and choose **Load unpacked** -> `packages/chrome-extension/dist`.
3. Follow [packages/VALIDACION_EN_VIVO.md](packages/VALIDACION_EN_VIVO.md) for live verification steps against a local controller.

---

## License

Apache-2.0 — see [LICENSE](LICENSE).
