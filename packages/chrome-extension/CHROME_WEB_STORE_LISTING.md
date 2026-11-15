# Guia y Ficha SEO para Publicar en Chrome Web Store — MCP-ROBOTSTUDIO RWS Monitor

Esta guia contiene **todos los artefactos, textos y justificaciones exactas** requeridos en el **Chrome Web Store Developer Dashboard** (cuenta `Data-Unix`) vinculados al repositorio publico `https://github.com/Data-Unix/mcp-robotstudio`.

---

## 1. Artefactos locales listos para subir

Antes de entrar al panel de Chrome Web Store, genera/actualiza los artefactos con:

```powershell
cd packages
npm run test
npm run pack:zip -w @mcp-robotstudio/chrome-extension
```

Archivos generados y listos:
- **Paquete ZIP (pestaña *Package*):** `packages/chrome-extension/mcp-robotstudio-rws-monitor.zip` (contiene `manifest.json` en la raiz del ZIP + bundle MV3 + iconos).
- **Icono 128x128 px (pestaña *Store listing*):** `packages/chrome-extension/dist/icons/icon128.png`.
- **Captura principal 1280x800 px (pestaña *Store listing*):** `packages/chrome-extension/docs/cws-screenshot-1280x800.png` (y captura vertical adicional `docs/panel-screenshot.png` si deseas subirla tras probarla).

---

## 2. Pestaña *Store listing* (Ficha SEO y metadatos)

- **Nombre de la extension (*Name* — heredado de `manifest.json`):**
  `MCP-ROBOTSTUDIO RWS Monitor`
- **Resumen corto (*Summary*, max. 132 caracteres — heredado de `manifest.json`):**
  `Monitor de solo lectura para ABB RobotStudio / RobotWare 6 via RWS 1.0 (Digest MD5): estado, modulos, senales, eventos y simbolos.`
  *(Alternativa en ingles, 128 caracteres: `Read-only monitor for ABB RobotStudio & RobotWare 6 via RWS 1.0 (Digest MD5): controller state, RAPID modules, signals and elog.`)*
- **Categoria (*Category*):** `Developer Tools` (`Herramientas para desarrolladores`)
- **Idioma principal (*Language*):** `Spanish` (o `English` si prefieres la ficha principal en ingles)
- **URL oficial / Sitio web (*Official URL / Homepage*):** `https://github.com/Data-Unix/mcp-robotstudio`
- **URL de soporte (*Support URL*):** `https://github.com/Data-Unix/mcp-robotstudio/issues`

### Descripcion detallada optimizada para SEO (copiar y pegar)

#### Version en ingles (recomendada para maximo alcance en busquedas globales)
```text
MCP-ROBOTSTUDIO RWS Monitor is a strictly READ-ONLY Manifest V3 Chrome Side Panel and Popup inspector for ABB RobotStudio Virtual Controllers and IRC5 industrial robots running RobotWare 6 (Robot Web Services / RWS 1.0).

Built as the companion browser monitor for the open-source mcp-robotstudio TypeScript MCP server (Apache-2.0), it connects directly over HTTP Digest MD5 (qop="auth") to inspect live controller telemetry without risk of modifying RAPID code, writing signals, or moving robot axes.

KEY CAPABILITIES (100% READ-ONLY)
• Controller & Execution Overview: robot system name, RobotWare version (e.g. 6.16), motor status (ctrlstate), operating mode (opmode: Auto / Manual Reduced Speed), RAPID execution state (running / stopped), cycle mode, and active tasks (T_ROB1).
• Live Motion Telemetry: joint targets (J1..J6 in degrees plus external axes) and Cartesian TCP robtarget coordinates (X, Y, Z, quaternion orientation, and configuration).
• RAPID Modules Inspector: lists loaded PROGMOD and SYSMOD modules via RobotWare 6 compliant endpoints (/rw/rapid/modules?task=...).
• Filterable I/O Signals Viewer: browse /rw/iosystem/signals with real-time substring search (DI, DO, GI, GO, DRV1, etc.) and live logic states.
• Controller Event Log: inspect the latest /rw/elog entries with domain, severity type, event code, timestamp, and description.
• RAPID Symbol Reader: read any PERS, VAR, or CONST RAPID variable (such as BASE/tool0) without altering program execution.

SECURITY & PRIVACY BY DESIGN
• Strictly read-only: zero write buttons, zero POST/PUT execution calls, and zero motion endpoints in the compiled extension bundle.
• RFC 7616 HTTP Digest MD5 (qop="auth"): rejects insecure HTTP Basic challenges so credentials are never transmitted in base64 cleartext.
• Session cookie reuse (ABBCX): prevents exhausting the RobotWare 6 limit of 70 concurrent RWS sessions.
• Session-only credential memory: connection targets reside locally in chrome.storage.local, while your optional RWS password and session cookie remain strictly in RAM via chrome.storage.session (TRUSTED_CONTEXTS) and are cleared when the browser closes.
• Optional LAN consent: only loopback (127.0.0.1 / localhost) is enabled by default; LAN IRC5 controller IPs require explicit runtime permission via chrome.permissions.request().
• Zero telemetry, zero analytics, zero remote code, strict MV3 Content Security Policy.

Source code, documentation, and MCP stdio server CLI:
https://github.com/Data-Unix/mcp-robotstudio
```

#### Version en espanol
```text
MCP-ROBOTSTUDIO RWS Monitor es un panel lateral (Side Panel) y popup ESTRICTAMENTE DE SOLO LECTURA para supervisar controladores virtuales de ABB RobotStudio y robots industriales IRC5 con RobotWare 6 mediante Robot Web Services (RWS 1.0).

Forma parte del ecosistema abierto mcp-robotstudio (servidor MCP en TypeScript y cliente RWS real bajo licencia Apache-2.0) y permite consultar la telemetria del robot en tiempo real sin ningun boton ni endpoint capaz de modificar codigo RAPID, escribir senales ni mover el robot.

FUNCIONALIDADES PRINCIPALES (100 % SOLO LECTURA)
• Estado del controlador: nombre del sistema, version de RobotWare (p. ej. 6.16), estado de motores, modo de operacion, estado de ejecucion RAPID y tareas activas (T_ROB1).
• Telemetria de movimiento: posicion articular (J1..J6 y ejes externos) y posicion cartesiana TCP robtarget (X, Y, Z, cuaternion).
• Modulos RAPID: listado de modulos cargados usando las rutas verificadas de RobotWare 6 (/rw/rapid/modules?task=...).
• Senales de E/S con filtro instantaneo: consulta senales digitales y analogicas con busqueda por subcadena.
• Registro de eventos (Event Log): ultimos avisos y errores del controlador con codigo, tipo y fecha.
• Lector de simbolos RAPID: consulta variables/constantes/persistentes (p. ej. BASE/tool0) de forma segura.

SEGURIDAD Y PRIVACIDAD POR DISENO
• Cero escritura: sin botones de arranque/parada, carga de modulos ni modificacion de variables.
• Autenticacion HTTP Digest MD5 (qop="auth") con rechazo de HTTP Basic.
• Reutilizacion de cookie de sesion ABBCX para evitar el error "Too many sessions 70/70" en RobotWare 6.
• Contrasena y cookie unicamente en RAM (chrome.storage.session con TRUSTED_CONTEXTS); nunca en disco ni en la nube.
• Solo localhost/127.0.0.1 por defecto; acceso a IPs LAN de IRC5 unicamente bajo permiso explicito en tiempo de ejecucion.
• Cero telemetria, cero analitica y cero codigo remoto.
```

---

## 3. Pestaña *Privacy practices* (Privacidad y permisos)

- **Privacy policy URL:**
  `https://github.com/Data-Unix/mcp-robotstudio/blob/main/packages/chrome-extension/PRIVACY_POLICY.md`

- **Single purpose description:**
  > Read-only monitor that inspects ABB RobotStudio / RobotWare 6 controller status, RAPID modules, I/O signals, event log entries, and RAPID symbol values over Robot Web Services (RWS 1.0 HTTP Digest).

- **Permission justifications:**
  - **`storage`:**
    > Stores non-sensitive connection parameters (host, port, RAPID task, username) locally in `chrome.storage.local` and keeps the transient RWS session cookie and optional session password exclusively in RAM via `chrome.storage.session` (`TRUSTED_CONTEXTS`).
  - **`sidePanel`:**
    > Allows robotics engineers and developers to keep the read-only controller telemetry monitor docked beside their browser workspace in Chrome's Side Panel.
  - **Host permissions (`http://127.0.0.1/*`, `http://localhost/*`, optional `http://*/*`):**
    > Required for the extension service worker to send direct read-only RWS 1.0 HTTP Digest `GET` requests to local ABB RobotStudio Virtual Controllers (`127.0.0.1`/`localhost` by default) or an explicit LAN IRC5 controller IP authorized interactively by the user via `chrome.permissions.request()`.
  - **Are you using remote code?**
    > **No**, I am not using remote code. All JavaScript, HTML, and CSS are bundled locally inside the extension under strict MV3 CSP (`script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none';`).

- **Data usage checkboxes:**
  - Deja **todas** las casillas de recopilacion de datos desmarcadas y selecciona la certificacion de que la extension no recopila ni transmite datos de usuario.

---

## 4. Pestaña *Account* e Instrucciones de prueba para revisores (*Reviewers / Test Instructions*)

En la seccion **Testing instructions** (o comentarios al revisor durante el envio), pega este texto para evitar rechazos automaticos por conectividad local:

```text
This extension is a specialized local developer tool for ABB RobotStudio / RobotWare 6 Virtual Controllers and IRC5 robots listening on loopback HTTP (http://127.0.0.1:<port>) via Robot Web Services (RWS 1.0).

How to test without a physical ABB robot:
1. Install the extension and open the extension Options page (`options.html`) or Side Panel / Popup (`panel.html`).
2. Confirm that the UI cleanly warns when no controller is reachable and provides explicit host/port configuration (loopback 127.0.0.1 enabled by default; LAN IP prompts via chrome.permissions.request()).
3. Alternatively, run the included open-source fixture server from the companion repository (https://github.com/Data-Unix/mcp-robotstudio):
   cd packages && npm ci && npm run build && node -e "import('./mcp-robotstudio/dist/testing/fake-rws-server.js').then(async ({FakeRwsServer}) => { const s = new FakeRwsServer(); console.log(await s.start()); })"
   Enter that printed loopback port in the extension Options page with default credentials ("Default User" / "robotics") and click "Probar conexion".

Security notes:
- Strictly read-only (HTTP GET only); contains zero write endpoints or motion commands.
- Passwords stay solely in `chrome.storage.session` (TRUSTED_CONTEXTS) and are never persisted to disk or sent externally.
```
