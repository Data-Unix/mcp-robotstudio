# Política de privacidad: MCP-ROBOTSTUDIO

**Última actualización:** 2026-11-15 (versión 0.2.0)
**Responsable:** `Data-Unix`, proyecto `mcp-robotstudio` (`https://github.com/Data-Unix/mcp-robotstudio`)

## 1. Propósito único

MCP-ROBOTSTUDIO muestra y opera desde el panel lateral de Chrome un controlador de robot ABB (controlador virtual de RobotStudio, IRC5 con RobotWare 6 u OmniCore con RobotWare 7-8) mediante Robot Web Services (RWS 1.0 y 2.0).

Por defecto solo lee. Las funciones que escriben en el controlador (SpeedRatio, variables PERS de receta, carga de módulos, backup a TEMP) exigen la suscripción PRO y además que el usuario active el modo escritura de la sesión en Opciones. La extensión no arranca, no para y no mueve el programa del robot.

## 2. Datos tratados y dónde se guardan

| Dato | Dónde | Para qué | ¿Sale del equipo? |
|---|---|---|---|
| Host, puerto, tarea, usuario, dialecto RWS y lista de celdas de la flota | `chrome.storage.local` | Recordar a qué controladores conectarse | No |
| Token de licencia PRO | `chrome.storage.local` | Comprobar localmente la firma de la licencia | No |
| Contraseña RWS, cookies de sesión (`-http-session-`, `ABBCX`) y modo escritura | `chrome.storage.session` (`TRUSTED_CONTEXTS`), solo en memoria; se borra al cerrar Chrome | Autenticarse con Digest MD5 (RWS 1.0) o Basic sobre HTTPS (RWS 2.0) y no agotar el límite de sesiones | Solo al controlador configurado |
| Ficheros `.rspag` y `.mod` que el usuario elige | Memoria del panel y de un Web Worker local | Auditar, anonimizar, comparar o validar | No. Los ficheros generados se descargan en el propio equipo |
| Telemetría, analítica, historial, identificadores personales | No se recopilan | | No |

## 3. Comunicaciones de red

- Todas las peticiones van directamente al controlador que el usuario configura (por defecto `http://127.0.0.1:80`). Cualquier host que no sea loopback requiere el permiso explícito `chrome.permissions.request()`.
- La verificación de la licencia es local (firma ECDSA P-256); la extensión no contacta con ningún servidor de licencias.
- No hay telemetría, analítica, publicidad ni servidores intermedios.
- No se carga ni ejecuta código remoto; todo el código va empaquetado.
- No se inyectan scripts en páginas web.

## 4. Campos para el panel de Chrome Web Store

- **Single purpose:** Inspect and operate ABB robot controllers (RobotStudio virtual controllers, IRC5, OmniCore) over Robot Web Services from a side panel.
- **`storage`:** connection settings, fleet list and licence token in `chrome.storage.local`; password, session cookies and write mode only in `chrome.storage.session`.
- **`sidePanel`:** keeps the instrumentation panel next to the user's work.
- **`offscreen`:** keeps the RWS subscription and the TCP sampling of the oscilloscope alive beyond the service-worker lifetime and parses the XHTML event documents with DOMParser.
- **Hosts:** `http://127.0.0.1/*`, `http://localhost/*`; optional `http://*/*`, `https://*/*` for controllers the user adds.
- **Remote code:** none.
- **Data usage:** no user data is collected or transmitted.
