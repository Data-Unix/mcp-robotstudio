# Ficha de Chrome Web Store: MCP-ROBOTSTUDIO v0.2.0

Textos, justificaciones e inventario de artefactos para el Developer Dashboard (cuenta `Data-Unix`, repositorio público `https://github.com/Data-Unix/mcp-robotstudio`).

## 1. Artefactos

```powershell
cd packages
npm ci
npm run build
npm test
npm run pack:zip -w @mcp-robotstudio/chrome-extension
npm run verify:zip -w @mcp-robotstudio/chrome-extension
python ../scripts/sync_version.py --check
```

| Artefacto | Ruta | Estado |
|---|---|---|
| Paquete | `packages/chrome-extension/mcp-robotstudio-rws-monitor.zip` (`manifest.json` en la raíz, versión 0.2.0) | generado por `pack:zip` |
| Icono 128x128 | `packages/chrome-extension/dist/icons/icon128.png` | generado por `build` |
| Captura 1 (1280x800) | `docs/cws-01-telemetria-cinematica-1280x800.png` | en vivo, IRB120_3_58 / RW 6.16 |
| Captura 2 (1280x800) | `docs/cws-02-forense-diff-1280x800.png` | en vivo |
| Captura 3 (1280x800) | `docs/cws-03-osciloscopio-flota-1280x800.png` | en vivo |
| Captura 4 (1280x800) | `docs/cws-04-alcance-recetas-1280x800.png` | en vivo |
| Captura 5 (1280x800) | `docs/cws-05-estudio-practicas-1280x800.png` | en vivo |
| Vídeo promocional | `docs/demo-mcp-robotstudio-pro.mp4` (H.264, 1280x720, 30 fps, 42,5 s, sin audio) | en vivo; el Dashboard pide una URL de YouTube, hay que subirlo allí |

`verify:zip` comprueba los 14 ficheros requeridos, la versión, la CSP y la sintaxis de cada JS, y que el paquete no lleve comentarios, emojis, URLs remotas, claves privadas, rutas de usuario, correos ni rastros de herramientas de IA. La versión de tienda de `knowledge.json` lleva solo el checklist de entrega, sin rutas internas ni resúmenes de incidentes.

Las cinco capturas son el viewport de la extensión (sin escritorio, barra de tareas ni notificaciones) y solo contienen los chunks PNG `IHDR`, `IDAT` e `IEND`.

El vídeo junta dos grabaciones simultáneas: el panel (screencast CDP de `scripts/video-live.mjs`, solo el viewport) y la región de la vista 3D de RobotStudio, sin cinta, árbol de estación ni barra de tareas. Muestra el pulso de `ARRAY` en el simulador de E/S y la TRAP `recorrer_array` (StorePath, recorrido, RestoPath) con los tiempos medidos por RWS. Sin pistas de audio ni etiquetas de codificador o autor.

## 2. Store listing

- **Nombre:** `MCP-ROBOTSTUDIO`
- **Resumen (manifest, 132 car. máx.):** `Instrumentacion para ABB RobotStudio e IRC5/OmniCore via RWS 1.0 y 2.0: telemetria, forense, osciloscopio, alcance y practicas.`
- **Categoría:** Developer Tools
- **Idioma:** español
- **Web:** `https://github.com/Data-Unix/mcp-robotstudio`
- **Soporte:** `https://github.com/Data-Unix/mcp-robotstudio/issues`

### Descripción (español)

```text
MCP-ROBOTSTUDIO es un panel de instrumentación para controladores ABB: controladores virtuales de RobotStudio y robots IRC5 (RobotWare 6, RWS 1.0) u OmniCore (RobotWare 7-8, RWS 2.0). Es la extensión del servidor MCP de código abierto mcp-robotstudio.

Cinco pestañas:

01 TELEMETRIA Y CINEMATICA
Gratis: un controlador, motores, modo, ejecución, J1..J6 y TCP en cuaternión (tool0/wobj0).
PRO: puntero de programa en vivo (módulo, rutina, línea), aviso de SpeedRatio por debajo del 100 % en AUTO con la penalización de ciclo y botón "Fijar 100%", barras de límites J1..J6, singularidad de muñeca (|J5| < 3 grados), codo y manipulabilidad, conversor OrientZYX / EulerZYX / NOrient / PoseMult.

02 FORENSE Y DIFF
Gratis: últimos 5 eventos del registro y aviso de parada con error.
PRO: caja negra forense (línea del PP y código alrededor, señales, pose, eventos y diagnóstico de incidentes conocidos; exporta JSON y Markdown), diff línea a línea entre el módulo en la RAM del controlador y un Golden Master, validador RAPID offline y carga de módulos que detecta el falso 204 de RobotWare 6.

03 OSCILOSCOPIO Y FLOTA
Gratis: lista de señales con filtro.
PRO: osciloscopio de hasta 8 señales digitales, TCP X/Y/Z y variables PERS con marcas de tiempo en ms; certificador del retorno StorePath/RestoPath (error en mm, CSV y Markdown); tabla de varias celdas (modo, SpeedRatio, sincronización SMB); backup a TEMP.

04 ALCANCE Y RECETAS
Gratis: lector de símbolos RAPID y conversor Euler / cuaternión.
PRO: sonda de alcance sin mover el robot (cinemática inversa del IRB 120 con barrido de inclinaciones y Offs), captura de la pose actual como robtarget y editor de recetas PERS que bloquea saltos mayores que delta_max, cuaterniones no unitarios y puntos fuera de alcance antes de escribir.

05 ESTUDIO DE PRACTICAS
Gratis: lista de verificación de entrega y diagnóstico de un .rspag (system.guid, rutas personales, metadatos de imágenes) en un Web Worker local.
PRO: asistente que audita el controlador (señales, tooldata de CalibData), valida alcance y genera el módulo .mod con variables PERS testigo y el README con la tabla de verificación; anonimiza el .rspag y extrae Preview.png sin metadatos.

Seguridad:
- Lectura por defecto. Las escrituras exigen la suscripción PRO y además activar el modo escritura de la sesión en Opciones (se borra al cerrar el navegador). La extensión nunca arranca, para ni mueve el programa.
- RWS 1.0 con HTTP Digest MD5; Basic solo se acepta sobre HTTPS (RWS 2.0).
- Contraseña y cookies de sesión solo en chrome.storage.session.
- Sin telemetría, sin analítica, sin código remoto.
```

### Modelo de suscripción

Una única suscripción, MCP-ROBOTSTUDIO PRO. Las funciones PRO se marcan en la interfaz y muestran el aviso de activación solo cuando se intentan usar. La licencia es un token firmado (ECDSA P-256) que se verifica localmente; la extensión no contacta con ningún servidor para validarla. El enlace de pago (`checkoutUrl`) está sin configurar en esta versión: hay que declararlo en el panel antes de cobrar.

## 3. Privacy practices

- **Privacy policy URL:** `https://github.com/Data-Unix/mcp-robotstudio/blob/main/packages/chrome-extension/PRIVACY_POLICY.md`
- **Single purpose:** Inspect and operate ABB robot controllers (RobotStudio virtual controllers, IRC5, OmniCore) over Robot Web Services from a side panel.
- **Justificación de permisos:**
  - `storage`: parámetros de conexión, flota y token de licencia en `chrome.storage.local`; contraseña, cookies de sesión y modo escritura solo en `chrome.storage.session`.
  - `sidePanel`: mantener el panel de instrumentación junto a la página de trabajo.
  - `offscreen`: documento offscreen que mantiene la suscripción RWS y el muestreo del TCP para el osciloscopio más allá del ciclo de vida del service worker, y analiza los documentos de eventos XHTML con DOMParser.
  - Hosts `http://127.0.0.1/*`, `http://localhost/*`; opcionales `http://*/*`, `https://*/*`: peticiones RWS al controlador que el usuario configura; cualquier host que no sea loopback se pide con `chrome.permissions.request()`.
- **Código remoto:** no. Todo el JavaScript va empaquetado; CSP `script-src 'self'; object-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none';`.
- **Datos:** no se recopila ni se transmite ningún dato del usuario.

## 4. Instrucciones para el revisor

```text
The extension talks to ABB robot controllers through Robot Web Services. Without a robot, use the open-source fixture server from the repository:

  cd packages && npm ci && npm run build
  node -e "import('./mcp-robotstudio/dist/testing/fake-rws-server.js').then(async ({FakeRwsServer}) => { const s = new FakeRwsServer(); console.log(await s.start()); })"

Enter the printed port in Options (user "Default User", password "robotics") and press "Probar conexion". Free features work immediately. PRO features need a licence token; a review token can be provided on request.
```
