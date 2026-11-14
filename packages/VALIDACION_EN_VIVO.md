# Guia de Validacion en Vivo — `mcp-robotstudio` y Extension Chrome (Solo Lectura)

> **Para:** Responsable de validacion en maquina local con RobotStudio 2025 (+ controlador virtual IRB 120, RobotWare 6.16).
> **Regla de seguridad:** Todos los pasos de este documento operan en modo **estrictamente de solo lectura** (HTTP `GET` con Digest MD5 `qop="auth"`). No modifican RAPID, senales ni mueven el robot.

## 0. Preparacion rapida (en la raiz del monorepo JS `packages/`)

```powershell
cd packages
npm ci
npm run build
```

Verifica que la version de Node sea `>= 20 LTS` (`node -v`).

---

## 1. Averiguar el puerto HTTP RWS activo del controlador virtual (`RobVC`)

El controlador virtual cambia de puerto RWS dinamicamente (puerto `80` u otro puerto libre). Obten el puerto real en escucha en PowerShell:

```powershell
$ids = (Get-Process RobVC).Id
Get-NetTCPConnection -State Listen |
  Where-Object { $ids -contains $_.OwningProcess } |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

Anota `<PUERTO>` (por ejemplo `80`, `51423`, etc.) en la direccion `127.0.0.1`.

---

## 2. Validar el servidor MCP TypeScript en modo SOLO LECTURA

Lanza el servidor MCP **sin** `--allow-write`:

```powershell
npx mcp-robotstudio --rws-url http://127.0.0.1:<PUERTO> --rws-user "Default User" --rws-pass robotics
```

*(Tambien puedes configurarlo en tu cliente MCP pasando `--rws-url http://127.0.0.1:<PUERTO>` y variables `RWS_URL`, `RWS_USER`, `RWS_PASS`.)*

Comprobaciones en vivo (sin modificar nada en el controlador):

1. `tools/list`: verifica que **solo** aparecen las 8 herramientas de solo lectura (`get_controller_state`, `list_modules`, `read_rapid_symbol`, `list_signals`, `read_signal`, `get_event_log`, `get_joints`, `get_tcp`) y **no** aparecen `write_rapid_symbol`, `load_module`, `start_rapid` ni `stop_rapid`.
2. Llama a `get_controller_state` -> debe devolver sistema (`rwversion` `6.16...`), `ctrlstate`, `opmode`, `ctrlexecstate` y tareas (`T_ROB1`).
3. Llama a `list_modules` -> debe listar los modulos usando la ruta RW6 `/rw/rapid/modules?task=T_ROB1` (no da 404).
4. Llama a `read_rapid_symbol` con `module: "BASE"`, `symbol: "tool0"` -> devuelve `[TRUE,[[0,0,0],[1,0,0,0]],...]`.
5. Llama a `list_signals` (con `filter: "DRV1"`), `get_event_log` (`limit: 5`), `get_joints` y `get_tcp`.
6. **Prueba de errores controlados (no muta estado):** llama a `read_rapid_symbol` con `module: "BASE"`, `symbol: "no_existe"` -> debe devolver el codigo/mensaje estructurado de RobotWare 6 (`Symbol not found`).

> **Puerta de parada (escritura):** No anadas `--allow-write` salvo peticion explicita y supervision humana del movimiento/estado del controlador. Si posteriormente decides probar escritura en entorno controlado, requiere `--allow-write` expreso y confirmacion humana previa segun `AGENTS.md`.

---

## 3. Validar la Extension de Chrome MV3 (Solo Lectura)

1. Abre Chrome en `chrome://extensions/`.
2. Activa **Modo de desarrollador** (arriba a la derecha).
3. Pulsa **Cargar descomprimida** y selecciona la carpeta:
   `packages/chrome-extension/dist`
4. Abre **Detalles** -> **Opciones de la extension** (o abre `options.html` desde el popup):
   - **Host:** `127.0.0.1`
   - **Puerto RWS HTTP:** `<PUERTO>` obtenido en el paso 1
   - **Tarea RAPID:** `T_ROB1`
   - **Usuario:** `Default User`
   - **Contrasena RWS:** `robotics` (se guarda solo en `chrome.storage.session`, RAM)
5. Pulsa **Probar conexion (solo lectura)** -> debe mostrar en verde el nombre del controlador, version RW y estado de motores.
6. Abre el **Popup** (icono de la extension) y/o el **Panel lateral** (*Side Panel*):
   - Verifica las tarjetas **Estado del controlador** (motores, modo, ejecucion, ejes J1..J6, TCP), **Modulos RAPID**, **Senales I/O**, **Ultimos eventos** y **Lectura de simbolo RAPID**.
   - Prueba el cuadro **Filtrar senales** (por ejemplo `DRV1` o `DI`) y la lectura de `BASE` / `tool0`.
   - Comprueba visualmente que **no existe ningun boton** que escriba simbolos/senales, cargue modulos ni arranque/pare RAPID.
7. Abre DevTools del *service worker* (en `chrome://extensions/` -> *service worker*):
   - En la pestana **Network**, confirma que tras la primera peticion (`401` Digest `qop="auth"`) las siguientes reutilizan la cookie `ABBCX` sin abrir nuevas sesiones ni enviar encabezados `Authorization: Basic` ni trafico externo.
   - En **Application -> Storage**, verifica que `Extension Storage -> Local` no contiene la contrasena y que esta solo reside en `Session` (`TRUSTED_CONTEXTS`).

---

## 4. Plantilla para registrar el resultado en vivo

```markdown
### Evidencia de validacion en vivo (Responsable de validacion en maquina local con RobotStudio 2025)
- Fecha y RobotWare real: 
- Puerto RobVC utilizado (`GET-NetTCPConnection`): 
- Servidor MCP (`npx mcp-robotstudio`, 8 herramientas solo lectura): [OK / incidencia]
- Salida literal relevante (`get_controller_state`, `list_modules`, `read_rapid_symbol`):
  ...
- Extension Chrome MV3 (`chrome-extension/dist` popup + side panel): [OK / incidencia]
- Reutilizacion cookie `ABBCX` sin sesiones extra / sin Basic: [OK / incidencia]
```
