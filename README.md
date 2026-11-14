# mcp-robotstudio

[![CI - Node Packages & Privacy Gate](https://github.com/Data-Unix/mcp-robotstudio/actions/workflows/ci.yml/badge.svg)](https://github.com/Data-Unix/mcp-robotstudio/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Node.js >= 20 LTS](https://img.shields.io/badge/Node-%3E%3D20%20LTS-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio%20SDK-blue.svg)](https://modelcontextprotocol.io/)

Real **ABB RobotWare 6 Robot Web Services (RWS 1.0)** client, **Model Context Protocol (MCP)** stdio server, and **read-only Manifest V3 Chrome Extension** in TypeScript (Node `>= 20 LTS`, ESM, Apache-2.0).

---

## Packages & Repository Layout

| Path | Description |
|---|---|
| [`packages/mcp-robotstudio`](packages/mcp-robotstudio/README.md) | Public npm package: real RWS 1.0 HTTP Digest (`MD5`, `qop="auth"`) client + MCP stdio server (`8` read-only tools by default; `4` write/execution tools only when `--allow-write` is passed) + CLI + `FakeRwsServer` for offline testing |
| [`packages/chrome-extension`](packages/chrome-extension/README.md) | Read-only Manifest V3 Chrome side-panel & popup monitor sharing the Web Standards RWS client (`RwsReadOnlyClient`, strict CSP, session-only credential storage) |
| [`referencias/rws-rw6-fixtures`](referencias/rws-rw6-fixtures/README.md) | Anonymized RobotWare 6.16 HTTP fixtures used by `FakeRwsServer` for deterministic unit, MCP stdio E2E, and Chrome E2E verification |
| [`scripts/check_privacy.py`](scripts/check_privacy.py) | Automated privacy gate & Pack&Go self-test executed in CI |
| [`scripts/anonymize_rspag.py`](scripts/anonymize_rspag.py) | Context-aware `.rspag` anonymizer that preserves binary blobs (`key.id`, geometry streams) and RAPID source identifiers |

---

## Security & Privacy Highlights

- **RFC 7616 / RFC 2617 HTTP Digest MD5 (`qop="auth"`)**: rejects HTTP `Basic` challenges (`BASIC_AUTH_REJECTED`) so credentials never travel in clear base64.
- **Persistent session cookie reuse (`ABBCX`)**: avoids exhausting the RobotWare 6 `Too many sessions 70/70` controller limit.
- **Read-only by default**: write/execution MCP tools (`write_rapid_symbol`, `load_module`, `start_rapid`, `stop_rapid`) are **never registered** in `tools/list` unless `--allow-write` is explicitly supplied.
- **MV3 Extension hardening**: strictly read-only bundle (verified against `dist/` in CI), zero `content_scripts`, zero remote hosted code, secrets stored strictly in `chrome.storage.session` (`TRUSTED_CONTEXTS`), audited in [SECURITY_REVIEW.md](packages/chrome-extension/SECURITY_REVIEW.md) and [PRIVACY_POLICY.md](packages/chrome-extension/PRIVACY_POLICY.md).
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
