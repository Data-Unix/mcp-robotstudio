# Politica de Privacidad — MCP-ROBOTSTUDIO RWS Monitor

**Ultima actualizacion:** 2026-11-15
**Responsable:** `Data-Unix` — Proyecto `mcp-robotstudio` (`https://github.com/Data-Unix/mcp-robotstudio`)

## 1. Proposito unico (Single Purpose)

La extension **MCP-ROBOTSTUDIO RWS Monitor** tiene un unico proposito: **mostrar en modo estrictamente de solo lectura** informacion operativa de un controlador ABB RobotStudio / RobotWare 6 (estado del sistema, motores, modo, ejecucion RAPID, ejes/TCP, modulos, senales I/O, registro de eventos y lectura de simbolos) mediante el protocolo local Robot Web Services (RWS 1.0).

La extension **no modifica el robot**, **no escribe variables ni senales**, **no carga programas** y **no inicia ni detiene la ejecucion RAPID**.

## 2. Datos tratados y almacenamiento

| Dato | Donde se guarda | Proposito | Se envia a terceros |
|---|---|---|---|
| Host, puerto, tarea RAPID (`T_ROB1`) y nombre de usuario configurados por el usuario | `chrome.storage.local` (solo en el navegador local) | Recordar el destino de lectura entre aperturas del panel | No |
| Contrasena RWS (opcional, sesion actual) | `chrome.storage.session` con `accessLevel = TRUSTED_CONTEXTS` (solo RAM de la sesion del navegador; se borra al cerrar Chrome y **nunca** se guarda en disco ni se sincroniza) | Calcular localmente el hash RFC 7616 HTTP Digest (`MD5`, `qop="auth"`) exigido por RWS | No. Nunca se transmite en claro (Basic rechazado) ni fuera del controlador configurado |
| Cookie de sesion RWS (`ABBCX`) | `chrome.storage.session` (`TRUSTED_CONTEXTS`) | Evitar agotar el limite de 70 sesiones concurrentes del controlador RobotWare 6 | Solo al propio controlador configurado |
| Telemetria, analitica, historial de navegacion, identificadores o PII | **No se recopilan** | — | No |

## 3. Destino de las comunicaciones de red

Todas las peticiones HTTP (`GET`) salen directamente desde el *service worker* de la extension hacia el origen local o de red local configurado explicitamente por el usuario en la pagina de Opciones (por defecto `http://127.0.0.1:80`).

- La extension **no** incluye telemetria, analitica, publicidad, balizas externas ni servidores intermedios.
- La extension **no** carga ni ejecuta codigo remoto (`remote hosted code`): todo el codigo JavaScript, HTML y CSS se empaqueta localmente en el paquete de la extension.
- La extension **no** inyecta *content scripts* en ninguna pagina web.

## 4. Cumplimiento de Limited Use y campos sugeridos para Chrome Web Store Dashboard

Si el propietario del repositorio decide publicar la extension en Chrome Web Store:

- **Single purpose description:**
  > Read-only monitor that inspects ABB RobotStudio / RobotWare 6 controller status, RAPID modules, I/O signals, event log entries, and RAPID symbol values over Robot Web Services (RWS 1.0 HTTP Digest).
- **`storage` permission justification:**
  > Stores non-sensitive connection parameters (host, port, RAPID task, username) in `chrome.storage.local` and keeps the transient RWS session cookie and optional session password exclusively in `chrome.storage.session` (`TRUSTED_CONTEXTS`).
- **`sidePanel` permission justification:**
  > Allows engineers to keep the read-only controller telemetry panel open beside their workspace in Chrome's Side Panel.
- **Host permissions (`http://127.0.0.1/*`, `http://localhost/*`) + optional host permissions (`http://*/*`) justification:**
  > Required for the service worker to send direct read-only RWS 1.0 HTTP Digest requests to local RobotStudio Virtual Controllers (loopback by default) or an explicit LAN IRC5 controller IP authorized interactively by the user via `chrome.permissions.request()`.
- **Remote code declaration:** **No**, the extension executes only packaged local files under strict MV3 CSP (`script-src 'self'; object-src 'self'`).
- **Data usage checkboxes:** All user-data collection categories unchecked (*"This item does not collect or use user data"*). Limited Use obligations honored because zero user/controller telemetry leaves the user's machine.
