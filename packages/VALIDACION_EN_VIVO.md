# Guia de Validacion en Vivo — `mcp-robotstudio` y Extension Chrome (Solo Lectura)

> **Para:** Responsable de validacion en maquina local con RobotStudio 2025 (+ controlador virtual IRB 120, RobotWare 6.16).
> **Regla de seguridad:** Todos los pasos de este documento operan en modo **estrictamente de solo lectura** (HTTP `GET` con Digest MD5 `qop="auth"`). No modifican RAPID, senales ni mueven el robot.

## 0. Preparacion rapida (en la raiz del monorepo JS `packages/`)

```powershell
cd packages
npm ci
npm run build
npm rebuild mcp-robotstudio --ignore-scripts
```

`npm rebuild` hace falta en un checkout limpio: durante `npm ci` todavia no existe `dist/cli.js`, npm no crea `node_modules/.bin/mcp-robotstudio` y `npx mcp-robotstudio` responde "no se reconoce como un comando" (comprobado 2026-11-15, Windows, Node 26).

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

## 5. Registro: v0.1.0, 2026-11-15 (RobotStudio 2025, estación `entregables/Practica63_Final.rspag` tras Unpack and Work)

- **Fecha y RobotWare real:** 2026-11-15 · `IRB120_3_58`, `rwversion` `6.16.3007`, `ctrlstate` `motoron`, `opmode` `AUTO`.
- **Puerto RobVC:** `80` (un único `RobVC.exe`).
- **Servidor MCP:** `npx mcp-robotstudio --version` → `mcp-robotstudio v0.1.0`. `initialize` → `serverInfo {"name": "mcp-robotstudio", "version": "0.1.0"}`, `protocolVersion 2024-11-05`. **OK**.
- **`tools/list`** (sin `--allow-write`): 8 herramientas, `['get_controller_state', 'list_modules', 'read_rapid_symbol', 'list_signals', 'read_signal', 'get_event_log', 'get_joints', 'get_tcp']`, y 0 de escritura. **OK**.
- **Salidas literales:**
  - `list_modules` (ruta RW6 `/rw/rapid/modules?task=T_ROB1`, sin 404) → `user`, `BASE`, `CalibData`, `Practica63_Final`.
  - `read_rapid_symbol BASE/tool0` → `[TRUE,[[0,0,0],[1,0,0,0]],[0.001,[0,0,0.001],[1,0,0,0],0,0,0]]`.
  - `get_event_log` → `Motors ON state`, `Motors OFF state`, …
  - `get_joints` → `rax_1..6 = 0, 0, 0, 0, 30.0000019073486, 0`.
  - `get_tcp` → `x 364.3538, y 0, z 594.0001`.
  - `read_rapid_symbol BASE/no_existe` → `isError: true`, `RWS HTTP 400 … Symbol not found code:-1073414146`.
- **Extensión Chrome MV3:** **OK**. Google Chrome 157.0.8103.39 instalado, perfil temporal vacío. `dist/` cargado con `Extensions.loadUnpacked` por CDP (`--enable-unsafe-extension-debugging`), que es lo que hace "Cargar descomprimida": desde Chrome 137 se ignora `--load-extension`.
  - `chrome.runtime.getManifest().version` → `0.1.0`.
  - Opciones `127.0.0.1` / `80` / `T_ROB1` / `Default User` / `robotics` → "Probar conexión" muestra `Conexion verificada con http://127.0.0.1:80: IRB120_3_58 (RW 6.16.3007), motores=motoron`.
  - El panel (`panel.html`, el mismo documento en el popup y en el side panel) muestra:
    - los módulos `user`, `BASE`, `CalibData` y `Practica63_Final`;
    - las DI `ARRAY`, `INTERRUPCION`, `CAMINO2` y `CAMINO1` (66/66 señales);
    - `motoron` y `AUTO`;
    - `T_ROB1/BASE/tool0 = [TRUE,[[0,0,0],[1,0,0,0]],[0.001,[0,0,0.001],[1,0,0,0],0,0,0]]`.

    Botones que escriban: 0. Captura: [`chrome-extension/docs/live-validation-panel.png`](chrome-extension/docs/live-validation-panel.png).
- **Cookie `ABBCX` / sin Basic (red del service worker, como en DevTools):** **OK**. Tras pulsar "Actualizar", las 10 peticiones son `GET`:
  - `/rw/system`, `/rw/panel/ctrlstate`, `/rw/panel/opmode`, `/rw/rapid/execution`, `/rw/rapid/tasks`, `/rw/rapid/modules`, `/rw/iosystem/signals`, `/rw/elog/0`, `…/jointtarget`, `…/robtarget`;
  - todas llevan las cookies `-http-session-,ABBCX` y ninguna cabecera `Authorization` (ni Digest ni Basic).

  Almacenamiento del service worker:
  - `chrome.storage.local` → claves `["rwsSettings"]`, sin la contraseña;
  - `chrome.storage.session` → `["rwsPassword"]`.
- **E2E Playwright de la extensión:** no se pudo ejecutar en este PC (Chromium no arranca: SxS, ver `agentes/memoria/incidentes/2026-11-15-playwright-chromium-sxs-windows.md`). Lo cubre la CI.

## 6. Registro: v0.2.0, 2026-11-15 (RobotStudio 2025, copia de validación)

Entorno: `Practica63_Final.rspag` copiado a `Documentos\RobotStudio\Validacion_v020\` y abierto con Unpack and Work en una carpeta nueva (la práctica final no se modifica; hash SHA-256 del `.rspag` idéntico antes y después: `7E5AE8DE…0518831`). Controlador `IRB120_3_58`, RobotWare `6.16.3007`, `http://127.0.0.1:80`, `AUTO`, `motoron`. Todas las acciones con movimiento o escritura se hicieron solo sobre esta copia, con la autorización del estudiante.

### 6.1 Servidor MCP, solo lectura

```
AFIRMACIÓN:  sin flags, el servidor expone 17 herramientas de lectura y ninguna de escritura
EVIDENCIA:   tools/list -> count 17 [get_controller_state … audit_rspag_package]; stderr "scopes=read-only dialect=auto->rws1"
FUENTE:      MCP stdio (dist/cli.js) contra /rw/* real
VERIFICADO:  sí
```
```
AFIRMACIÓN:  get_program_pointer devuelve PP y MP reales mientras se ejecuta Practica63_Final
EVIDENCIA:   reset_pp -> "PP Practica63_Final/main 75:9"; t+1.5s "PP Practica63_Final/main 87:21"; t+4.5s "86:21"
             GET /rw/rapid/tasks/T_ROB1/pcp -> <span class="beginposition">87,21</span>…<span class="modulemame">Practica63_Final</span> | motionpointer <span class="begposition">87,27</span><span class="modulename">…
FUENTE:      /rw/rapid/tasks/T_ROB1/pcp (fixture 16-pcp-en-ejecucion.json)
VERIFICADO:  sí
```
```
AFIRMACIÓN:  con el PP sin fijar, pcp devuelve SYS_CTRL_E_EXEC_STATE y la caja negra lo diagnostica
EVIDENCIA:   programPointer.errorCode "-1073442809"; /rw/retcode?code=-1073442809 -> "Operation is illegal in current execution state."; diagnosis ["pp-not-set"]
FUENTE:      /rw/rapid/tasks/T_ROB1/pcp, /rw/retcode (fixture 17-pcp-sin-pp.json)
VERIFICADO:  sí
```
```
AFIRMACIÓN:  get_speed_ratio y get_user_privileges leen el controlador real
EVIDENCIA:   {"speedRatio":100,"cycleTimeFactor":1}; users ["Default User"], rmmp privilege "none", 25 grants (UAS_FULL_ACCESS, UAS_BACKUP, UAS_RAPID_EXECUTE…), unavailable []
FUENTE:      /rw/panel/speedratio, /users, /users/rmmp, /users/grants
VERIFICADO:  sí
```
```
AFIRMACIÓN:  read_module_source extrae el módulo de la RAM y no deja ficheros en TEMP
EVIDENCIA:   tempFile "$TEMP/mcp91ee.mod", cleanedUp true, firstLine "MODULE Practica63_Final", 96 líneas; GET /fileservice/$TEMP después -> lista vacía
FUENTE:      POST /rw/rapid/modules/Practica63_Final?task=T_ROB1&action=save + /fileservice/$TEMP
VERIFICADO:  sí
```
```
AFIRMACIÓN:  RW 6.16 guarda "<nombre>.mod" con nombres de 7 caracteres y trunca a 7 sin extensión los más largos
EVIDENCIA:   name=mcp_probe_mod -> fichero "mcp_pro"; path=$TEMP/mcpprobe -> "mcpprob"; name=mcpf7a6 -> "mcpf7a6.mod"
FUENTE:      /fileservice/$TEMP (ficheros de prueba borrados con DELETE -> 204)
VERIFICADO:  sí
```
```
AFIRMACIÓN:  diff_module_with_golden compara RAM y Golden Master; con el programa parado sin ejecutar es idéntico
EVIDENCIA:   antes de ejecutar: {"identical":true,"added":0,"removed":0}; tras ejecutar e interrumpir: "DIFERENTE: +4 / -4" (PERS nCeldasMatriz 0->450, nPasadasArray 0->1, pInterrupcion y pVuelta con la pose real)
FUENTE:      read_module_source + practicas/6.3-colisiones-interrupciones/rapid/Practica63_Final.mod
VERIFICADO:  sí
```
```
AFIRMACIÓN:  validate_rapid_offline y probe_reach_kinematics validan el módulo real y su alcance con MyTool
EVIDENCIA:   ok true, errors 0, warnings 0, P_MATRIZ reach=true, P_ARRAY reach=true; P_MATRIZ + Offs(0,0,30) + Offs(160,160,30) allReachable true, joints [26.65,-21.54,49.33,-32.08,31.33,49.74]
FUENTE:      cinemática offline del IRB 120 (FK cuadrada con el controlador: [0,0,0,0,30,0] -> [364.3538, 0, 594.0001])
VERIFICADO:  sí
```
```
AFIRMACIÓN:  audit_rspag_package da OK al entregable y detecta los guid
EVIDENCIA:   verdict "ok", system.guid {7A8BF1E4-734F-4AE3-848F-F8433D77861B}, template.guid {7351C77F-478C-4197-89E4-DB4C9872CE2D}, privacy 0
FUENTE:      practicas/6.3-colisiones-interrupciones/entregables/Practica63_Final.rspag
VERIFICADO:  sí
```
```
AFIRMACIÓN:  el registro de auditoría es encadenado e íntegro
EVIDENCIA:   verifyAuditLog -> {"ok":true,"records":11}
FUENTE:      --audit-log (JSONL temporal, fuera del repo)
VERIFICADO:  sí
```

### 6.2 Suscripción WebSocket real

```
AFIRMACIÓN:  POST /subscription + WebSocket robapi2_subscription entregan eventos con marca en ms al pulsar ARRAY
EVIDENCIA:   [+291 ms] mode websocket, location ws://127.0.0.1:80/poll/6
             [+21314 ms] /rw/iosystem/signals/ARRAY;state {"lvalue":"1"}
             [+22507 ms] /rw/iosystem/signals/ARRAY;state {"lvalue":"0"}
             [+25389 ms] .../Practica63_Final/nPasadasArray;value {"value":"1"}   (PERS, prioridad 2)
FUENTE:      WebSocket ws://127.0.0.1:80/poll/<id>; pulso en el Simulador de E/S de RobotStudio
VERIFICADO:  sí
```
```
AFIRMACIÓN:  el controlador aplica las reglas de prioridad que valida el cliente
EVIDENCIA:   /rw/panel/ctrlstate con -p=2 -> 400 "Resource can not be subscribed on Highpriority"; P_MATRIZ (CONST) con -p=2 -> 400 "Invalid resource URI in Create Subscription request"
FUENTE:      POST /subscription
VERIFICADO:  sí
```
```
AFIRMACIÓN:  la URI de cambio de PP existe en RW 6.16 y el valor de un PERS llega en un <li class="rap-data"> hermano
EVIDENCIA:   /rw/rapid/tasks/T_ROB1/pcp;programpointerchange -> 201; trama <li class="rap-pp-ev">…<span class="BegPosLine">87</span>; trama <li class="rap-value-ev">…</li><li class="rap-data">…<span class="value">217</span>
FUENTE:      WebSocket (fixtures 18-evento-ws-pers-value.json, 19-evento-ws-pp-change.json)
VERIFICADO:  sí
```

### 6.3 Escritura y movimiento (scopes)

```
AFIRMACIÓN:  con --allow-motion, reset_pp, start_rapid, stop_rapid y set_speed_ratio actúan sobre el controlador
EVIDENCIA:   reset_pp 204; start_rapid "ctrlexecstate=running"; set_speed_ratio 50 -> 204, get_speed_ratio 50; set 100; stop_rapid "ctrlexecstate=stopped"; elog 10140 "Speed adjusted", 10125 "Program stopped"
FUENTE:      /rw/rapid/execution, /rw/panel/speedratio, /rw/elog/0
VERIFICADO:  sí
```
```
AFIRMACIÓN:  capture_forensic_blackbox tras la parada captura PP, código, pose y eventos
EVIDENCIA:   "PP | Practica63_Final/main linea 86:21"; ">  86  MoveJ Offs(P_MATRIZ,c*PASO,f*PASO,ALTO),v300,fine,MyTool\WObj:=wobj0;"; TCP [263.6731, 130, 435.5315]; eventos 10125, 10140
FUENTE:      pcp + read_module_source + /rw/elog/0 + motionsystem
VERIFICADO:  sí
```
```
AFIRMACIÓN:  load_module detecta el falso 204 de RW6 y la validación offline evita subir módulos mal cerrados
EVIDENCIA:   V020Bad: stage "offline-validation", errores UNCLOSED_BLOCK/BLOCK_MISMATCH, no se sube nada
             V020Syn: statusCode 204, presente en /rw/rapid/modules, elog 40322 "Load error" -> success false
             V020Ok2 (nombres únicos): 204, presente, sin errores nuevos -> success true
             Módulos de prueba descargados después: unloadmod 204, DELETE $HOME/*.mod 204; módulos finales user,BASE,CalibData,Practica63_Final
FUENTE:      /fileservice/$HOME, /rw/rapid/tasks/T_ROB1?action=loadmod|unloadmod, /rw/elog/0
VERIFICADO:  sí
```
```
AFIRMACIÓN:  trigger_controller_backup crea el backup en TEMP; RW 6.16 exige la ruta en formato fileservice
EVIDENCIA:   backup=$TEMP/mcp_v020_bk -> 400 "Invalid File Service path"; backup=/fileservice/$TEMP/mcp_v020_bk -> 202 Location /progress/1
             trigger_controller_backup -> statusCode 202, state "Backup Ready"; 21 ficheros, 43909 bytes; borrado después, $TEMP vacío
FUENTE:      POST /ctrl/backup?action=backup, /ctrl/backup?action=backupstate, /fileservice/$TEMP
VERIFICADO:  sí
```

### 6.4 Extensión Chrome v0.2.0 en Chrome 157 (carga por CDP Extensions.loadUnpacked)

```
AFIRMACIÓN:  la extensión 0.2.0 conecta con el controlador real y guarda la contraseña solo en sesión
EVIDENCIA:   version "0.2.0"; "Conexion verificada con http://127.0.0.1:80: IRB120_3_58 (RW 6.16.3007), motores=motoron"; storage.local ["rwsSettings"]; storage.session ["rwsPassword"]
FUENTE:      packages/chrome-extension/scripts/live-chrome.mjs
VERIFICADO:  sí
```
```
AFIRMACIÓN:  FREE: las 5 pestañas funcionan en vivo y las funciones PRO quedan bloqueadas
EVIDENCIA:   plan "FREE", pestañas ["01 TELEMETRIA Y CINEMATICA","02 FORENSE Y DIFF","03 OSCILOSCOPIO Y FLOTA","04 ALCANCE Y RECETAS","05 ESTUDIO DE PRACTICAS"]; 5 eventos; 66/66 señales; CalibData/MyTool leído; auditoría del .rspag "VEREDICTO: OK" en el Web Worker
FUENTE:      live-chrome.mjs sin licencia
VERIFICADO:  sí
```
```
AFIRMACIÓN:  PRO: las funciones de las 5 pestañas funcionan contra el controlador real
EVIDENCIA:   01 "PP Practica63_Final / main / linea 86:21", SMB Synchronized, |J5| 36.36 deg OK, manipulabilidad rel 0.868
             01 SpeedRatio 50 % -> aviso "AUTO con SpeedRatio 50 %: el ciclo tarda x2.00." -> "Fijar 100%" -> controlador speedratio 100
             02 caja negra con ">  86 MoveJ Offs(P_MATRIZ…"; diff "+4 / -4"; validador "VALIDO … errores 0"
             03 osciloscopio "polling (WebSocket upgrade refused)" con ARRAY, nCeldasMatriz, nPasadasArray y TCP; certificador 0.4554 mm / 0.0145 deg OK; flota "IRB120_3_58 RW 6.16.3007 rws1 AUTO motoron running 100 % Synchronized"
             04 sonda: P_MATRIZ y Offs alcanzables; teach "CONST robtarget pNuevo:=[[420.01,170.00,214.54],…"; escudo receta +200 mm "BLOQUEADO - TCP jump 200.0 mm exceeds delta_max 50 mm"
             05 auditoría EIO 66 señales + CalibData MyTool; generador pickplace con TRAP y README
FUENTE:      live-chrome.mjs con licencia de laboratorio y modo escritura de sesión
VERIFICADO:  sí
```
```
AFIRMACIÓN:  desde la extensión el WebSocket no puede reutilizar la sesión RWS; el osciloscopio cae a polling
EVIDENCIA:   cookies RW6 "-http-session-=…; path=/; domain=127.0.0.1; httponly" y "ABBCX=…" sin SameSite; handshake desde la página offscreen sin Cookie -> 401 -> "polling (WebSocket upgrade refused)". Probado también inyectar la cookie con una regla DNR de sesión: Chrome no la aplica a la petición de la propia extensión (se descartó y no se piden esos permisos).
FUENTE:      Chrome 157 + FakeRwsServer (registro WS-REJECT) + controlador real
VERIFICADO:  sí
```
```
AFIRMACIÓN:  las 5 capturas oficiales son 1280x800, de uso real y sin metadatos ni datos personales
EVIDENCIA:   chunks IHDR, IDAT…, IEND en las 5; revisadas visualmente: solo el viewport de la extensión
FUENTE:      packages/chrome-extension/docs/cws-0[1-5]-*-1280x800.png
VERIFICADO:  sí
```
```
AFIRMACIÓN:  el servidor MCP y la extensión devuelven lo mismo para cada módulo compartido
EVIDENCIA:   node scripts/compat-live.mjs (MCP stdio en solo lectura + extensión por CDP, mismo controlador) -> "Resultado: 23/23 iguales."
FUENTE:      packages/COMPATIBILIDAD_MCP_EXTENSION.md
VERIFICADO:  sí
```
```
AFIRMACIÓN:  vídeo promocional grabado en vivo: 5 pestañas y vista 3D con la TRAP de ARRAY (StorePath / RestoPath)
EVIDENCIA:   docs/demo-mcp-robotstudio-pro.mp4: h264 1280x720 30 fps, 42,5 s, sin audio; ffprobe solo muestra major_brand/handler (sin encoder ni autor)
             PP leído por RWS cada 150 ms durante la toma: ARRAY=1 -> recorrer_array línea 48 (+0,00 s), línea 55 (+0,62 s), nPasadasArray 2 -> 3 (+3,93 s), main línea 88 (+6,11 s)
             certificador 0,4423 mm / 0,0170 deg OK; 42 fotogramas (1 por segundo) revisados: sin escritorio, barra de tareas, notificaciones ni datos personales
FUENTE:      scripts/video-live.mjs (screencast CDP del panel) + captura de la región 3D de RobotStudio en la copia de validación
VERIFICADO:  sí
```

Pendiente: validación contra un OmniCore real (RWS 2.0 solo cubierto por el simulador).
