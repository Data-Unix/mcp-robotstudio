# Real RWS 1.0 responses (RobotWare 6.16)

Captured on **2026-11-14** from an IRB 120 virtual controller (RobotWare 6.16.3007, RobotWare Base system). **Only GET requests** were used: nothing was written to the controller. They are meant to build **fake RWS servers and tests** on machines without RobotStudio.

Each `.json` file contains `request`, `status`, the relevant `headers`, a `note` and the literal `body`. Redacted: `nonce`, `opaque`, session cookies and any Windows user path. The paths `C:\BUILDAGENTS\...` that appear in the errors are ABB's own (the controller build), not the user's.

| File | Request | Status | What it shows |
|---|---|---|---|
| `00-challenge-sin-credenciales` | `GET /rw/system` without credentials | 401 | `WWW-Authenticate: Digest realm="validusers@robapi.abb", qop="auth", algorithm="MD5"`; body `Access Denied. Login required` |
| `01-system` | `/rw/system` | 200 | Name, RobotWare version |
| `02`, `03`, `04` | `/rw/panel/ctrlstate`, `/rw/panel/opmode`, `/rw/rapid/execution` | 200 | `<span class="ctrlstate">`, `opmode`, `ctrlexecstate`/`cycle` |
| `05-rapid-tasks` | `/rw/rapid/tasks` | 200 | Tasks |
| `06-rapid-modules-rw6` | `/rw/rapid/modules?task=T_ROB1` | 200 | **Valid** module list in RW6 (`<span class="name">`) |
| `07-rapid-modules-ruta-rw7-404` | `/rw/rapid/tasks/T_ROB1/modules` | 404 | RW7 route that does not exist in RW6 |
| `08-symbol-tool0` | `/rw/rapid/symbol/data/RAPID/T_ROB1/BASE/tool0` | 200 | Reading a symbol (`class="value"`) |
| `09-symbol-no-existe` | missing symbol | 400 | `<span class="code">-1073414146</span>` + `<span class="msg">… Symbol not found …</span>` |
| `10-signals-pagina` | `/rw/iosystem/signals?start=0&limit=5` | 200 | Paginated list (name, type, `lvalue`) |
| `11-signal-por-nombre` | `/rw/iosystem/signals/<name>` | 200 | A single signal |
| `12-elog-dominio0` | `/rw/elog/0?lang=en&lim=3` | 200 | Events (`code`, `msgtype`, `tstamp`, `title`, `desc`) |
| `13`, `14` | `jointtarget`, `robtarget?tool=tool0&wobj=wobj0&coordinate=Wobj` | 200 | Robot joints and TCP |
| `15-mastership` | `/rw/mastership` | 200 | Mastership domains (cfg, motion, rapid) |

## Captures added for v0.2.0 (2026-11-15, validation copy of Practica63_Final)

| File | Request | Note |
|---|---|---|
| `16-pcp-en-ejecucion.json` | `GET /rw/rapid/tasks/T_ROB1/pcp` while running | PP: `beginposition`/`modulemame`; MP: `begposition`/`modulename` |
| `17-pcp-sin-pp.json` | same, stopped with PP not set | `rel="error"` link with `-1073442809` |
| `18-evento-ws-pers-value.json` | WebSocket frame, PERS `;value` | value in a sibling `<li class="rap-data">` |
| `19-evento-ws-pp-change.json` | WebSocket frame, `pcp;programpointerchange` | `rap-pp-ev` with `BegPosLine`/`BegPosCol` |

## Cases seen in this session that cannot be captured with GET only

These cases need writes or force errors, so only the literal fragment that was observed is recorded:

| Case | Request | What the controller answered |
|---|---|---|
| Writing a DI with no device | `POST /rw/iosystem/signals/<DI>?action=set` (`lvalue=1`) | HTTP error, body with `rws_resource_iosystem.cpp[3554] Rejected code:-1073445881 icode:-2` |
| Too many sessions | any request after opening ~70 sessions without reusing the cookie | `Too many sessions 70/70` |
| Loading a module with syntax errors | `POST /rw/rapid/tasks/T_ROB1?action=loadmod` | **204** (success) even though it does not load; the event log shows `Load error … RAPID syntax error(s)` |

To create more fixtures: `scripts/rws_live_control.py` against a virtual controller, using GET requests only.
