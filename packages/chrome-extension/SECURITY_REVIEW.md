# Auditoria de Seguridad — Extension Chrome MV3 y Paquete npm `mcp-robotstudio`

> **Cambios de la v0.2.0 que sustituyen a las filas "solo lectura" de abajo (que describen la v0.1.0):**
> - La extensión ya no es solo de lectura. Las escrituras (`setSpeedRatio`, `writeRecipe`, `loadModuleSafe`, `triggerBackup`) solo existen en `background.js` y se rechazan antes de cualquier petición si falta la licencia PRO o el modo escritura de la sesión (`PRO_WRITE_ACTIONS` en `src/background.ts`; test `tests/license-gating.test.ts`). La extensión no llama a `startRapid`, `stopRapid` ni `resetProgramPointer` (`tests/bundle-audit.test.ts`).
> - Permiso nuevo `offscreen` (motivo `DOM_PARSER`) y hosts opcionales `https://*/*` para RWS 2.0. CSP con `worker-src 'self'` para `rspag-worker.js`.
> - Licencia PRO: token ECDSA P-256 verificado localmente con WebCrypto; en el paquete solo va la clave pública (`src/license-public-key.ts`). La privada vive en `.license-lab/`, ignorada por git y excluida del export público (`scripts/export_public_release.py`, `EXCLUDED_DIRS` y `FORBIDDEN_ANYWHERE_DIRS`).
> - Verificado en Chrome 157: el handshake WebSocket desde la página offscreen no lleva las cookies de sesión RWS (sin `SameSite`, por tanto Lax) y las reglas DNR no se le aplican; el controlador responde 401 y el osciloscopio pasa a polling. No se pidieron permisos `cookies` ni `declarativeNetRequest`.

**Fecha:** 2026-11-15
**Rama:** `feature/js-rws-mcp`
**Alcance:**
1. Extension Chrome Manifest V3 `packages/chrome-extension` (**estrictamente de solo lectura**)
2. Paquete npm publico `packages/mcp-robotstudio` (Node `>= 20 LTS`, ESM, Apache-2.0)

---

## 1. Tabla de cumplimiento — Chrome for Developers y Chrome Web Store

| Requisito | Documento oficial (URL) | Como se cumple | Evidencia (`archivo:linea` o `comando -> salida`) | Estado |
|---|---|---|---|---|
| 1. Principios de seguridad, minimo privilegio y superficie reducida | Stay secure — https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure | Solo lectura (`RwsReadOnlyClient` en `background.ts`, cero endpoints de escritura en el bundle), sin `content_scripts`, sin `web_accessible_resources`, sin `externally_connectable`, validacion de remitente interno (`sender.id === chrome.runtime.id`) y rechazo de HTTP Basic (`BASIC_AUTH_REJECTED`). | `packages/chrome-extension/public/manifest.json:12-22`; `packages/chrome-extension/src/background.ts:1,142-149`; `packages/mcp-robotstudio/src/rws/digest.ts:84` | cumple |
| 2. Migracion/seguridad MV3: eliminar `eval`, `innerHTML` y cargas remotas | Improve extension security (MV3) — https://developer.chrome.com/docs/extensions/develop/migrate/improve-security | Todo el DOM se construye con `document.createElement()` y `.textContent` (`panel.ts` y `options.ts`); cero `eval`, `new Function`, `setTimeout` con cadena, `innerHTML`, `outerHTML`, `insertAdjacentHTML` o `document.write`, verificado tanto en codigo fuente como sobre el bundle compilado `dist/`. | `packages/chrome-extension/src/panel.ts:33,47-74,113-155`; `packages/chrome-extension/src/options.ts:36`; `npx.cmd vitest run --dir chrome-extension tests/bundle-audit.test.ts` -> `2 passed (2)`; scan `Select-String` en `dist/*.{js,html}` -> `DIST_FORBIDDEN_HITS=0` | cumple |
| 3. Cero codigo remoto (*Remote hosted code*) | Remote hosted code — https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code | Todo el TypeScript (`background.ts`, `panel.ts`, `options.ts` + cliente `mcp-robotstudio/rws`) y estilos/HTML se empaquetan localmente en `dist/` con `esbuild-wasm`. Cero `<script src="http...">`, cero imports dinamicos externos ni URLs remotas en el bundle. | `packages/chrome-extension/build.mjs`; `Select-String` sobre `dist/*.{js,html}` -> `DIST_EXT_URL_HITS=0`; `packages/chrome-extension/tests/bundle-audit.test.ts` | cumple |
| 4. Content Security Policy (CSP) explicita MV3 | Content Security Policy — https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy | `content_security_policy.extension_pages` declarada explicitamente como `"script-src 'self'; object-src 'self'; base-uri 'none'; frame-ancestors 'none';"`, sin `'unsafe-eval'`, sin `'unsafe-inline'` ni origenes remotos. | `packages/chrome-extension/public/manifest.json:23-25`; verificado en `chrome-extension/tests/bundle-audit.test.ts` | cumple |
| 5. Declaracion de permisos minimos y opcionales en runtime | Declare permissions — https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions | Solo permisos estrictos `["storage", "sidePanel"]`. `host_permissions` limitado a loopback (`"http://127.0.0.1/*"`, `"http://localhost/*"`). Cualquier IP de controlador en LAN usa `optional_host_permissions: ["http://*/*"]` y se solicita con `chrome.permissions.request` previa explicacion en la UI. | `packages/chrome-extension/public/manifest.json:12-22`; `packages/chrome-extension/src/options.ts:40-47`; `packages/chrome-extension/src/background.ts:32-38` | cumple |
| 6. Avisos de permisos visibles para el usuario | Permissions list — https://developer.chrome.com/docs/extensions/reference/permissions-list | Documentado al detalle en §2: `storage` y `sidePanel` no muestran aviso de instalacion; `http://127.0.0.1/*` + `http://localhost/*` muestran aviso limitado a `127.0.0.1` y `localhost`; un host LAN opcional pide consentimiento explicito en runtime solo para ese host. | `packages/chrome-extension/public/manifest.json:12-22`; seccion §2 de este documento | cumple |
| 7. Peticiones de red cross-origin y justificacion de HTTP en claro | Cross-origin network requests — https://developer.chrome.com/docs/extensions/develop/concepts/network-requests | RWS 1.0 en ABB RobotWare 6 escucha unicamente en HTTP (sin TLS). Mitigado por: (a) defecto loopback `127.0.0.1:80`, (b) autenticacion HTTP Digest MD5 `qop="auth"` con rechazo estricto de Basic (`BASIC_AUTH_REJECTED`), (c) permiso explicito por IP para LAN y (d) aviso visible en `panel.html` y `options.html` cuando `!isLoopbackHost(host)`. | `packages/chrome-extension/src/storage.ts:74`; `packages/chrome-extension/public/panel.html:23`; `packages/chrome-extension/public/options.html:20`; `packages/mcp-robotstudio/src/rws/digest.ts:84` | cumple |
| 8. Uso seguro de `chrome.storage` (secretos solo en `session`) | chrome.storage — https://developer.chrome.com/docs/extensions/reference/api/storage | Host/puerto/tarea/usuario (no secretos) en `chrome.storage.local`; contrasena RWS (`rwsPassword`) y cookie `ABBCX` exclusivamente en `chrome.storage.session` con `setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })` (nunca en `local` ni `sync`, nunca en logs ni mensajes salientes). Verificado automaticamente en Playwright E2E. | `packages/chrome-extension/src/storage.ts:98-165`; `packages/chrome-extension/tests/extension-e2e.test.ts` (`localDump` no contiene `robotics` ni `rwsPassword`) | cumple |
| 9. Mensajeria interna validada | Message passing — https://developer.chrome.com/docs/extensions/develop/concepts/messaging | `chrome.runtime.onMessage` valida `sender.id === chrome.runtime.id` y `sender.url.startsWith(ownOrigin)`, y no expone acciones de escritura ni `externally_connectable`. | `packages/chrome-extension/src/background.ts:142-149`; `packages/chrome-extension/public/manifest.json` (ausencia de `externally_connectable`) | cumple |
| 10. Sin recursos accesibles desde la web | Web accessible resources — https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources | No se declara `web_accessible_resources` ni `content_scripts`, evitando exposicion de recursos o superficies de ataque desde paginas web arbitrarias. | `packages/chrome-extension/public/manifest.json` + asercion `expect(manifest.web_accessible_resources).toBeUndefined()` en `bundle-audit.test.ts` | cumple |
| 11. Politicas del programa CWS y proposito unico | Program Policies — https://developer.chrome.com/docs/webstore/program-policies/policies | Proposito unico declarado (monitorizacion de solo lectura de RobotWare 6 via RWS); sin telemetria, sin anuncios, sin funciones ocultas ni alteracion de paginas web. | `packages/chrome-extension/PRIVACY_POLICY.md` §1; `packages/chrome-extension/public/manifest.json:5`; badge `SOLO LECTURA` en `panel.html:13` | cumple |
| 12. Uso Limitado (*Limited Use*) | Limited Use — https://developer.chrome.com/docs/webstore/program-policies/limited-use | Cero transmision de datos de usuario o del controlador a servidores propios o terceros; todo el flujo HTTP ocurre unicamente hacia la IP configurada por el usuario. | `packages/chrome-extension/PRIVACY_POLICY.md` §2-4; `Select-String` en `dist/` -> `DIST_EXT_URL_HITS=0` | cumple |
| 13. Requisitos de tratamiento de datos (politica requerida incluso en local) | Handling requirements — https://developer.chrome.com/docs/webstore/program-policies/data-handling | Politica de privacidad redactada explicitamente en `PRIVACY_POLICY.md` indicando que no se recopilan datos personales ni telemetria y detallando el ciclo local/`session`. | `packages/chrome-extension/PRIVACY_POLICY.md` | cumple |
| 14. Campos de privacidad del Panel CWS | Privacy fields — https://developer.chrome.com/docs/webstore/cws-dashboard-privacy | Textos exactos preparados para *Single Purpose*, justificacion de cada permiso (`storage`, `sidePanel`, host loopback y opcional) y declaracion de uso de datos para el formulario de CWS Developer Dashboard. | `packages/chrome-extension/PRIVACY_POLICY.md` §4 | cumple |
| 15. Buenas practicas de publicacion y revision CWS | Best practices — https://developer.chrome.com/docs/webstore/best-practices | Iconos propios generados en 16/48/128 px, bundle legible no ofuscado (`minify: false`), descripcion fiel al alcance de solo lectura, guia de prueba local sin servidor externo. | `packages/chrome-extension/build.mjs`; `packages/chrome-extension/public/manifest.json:6-10`; `packages/VALIDACION_EN_VIVO.md` | cumple |
| 16. Evitar rechazos frecuentes (Blue Argon / codigo remoto / permisos excesivos) | Troubleshooting violations — https://developer.chrome.com/docs/webstore/troubleshooting | Evitado Blue Argon al eliminar `<script src>` remotos y cualquier URL externa de `dist/*.js`, evitando `optional_host_permissions` en exceso y sustituyendo mensajes de error opacos. | `packages/chrome-extension/tests/bundle-audit.test.ts` (`2 passed (2)`) | cumple |
| 17. Actualizaciones de politicas 2026 | Policy updates 2026 — https://developer.chrome.com/blog/cws-policy-updates-2026 | Verificada transparencia previa al consentimiento para conexiones HTTP LAN (banner de advertencia visible antes y despues de conectar + solicitud interactiva por origen + politica local publicada). | `packages/chrome-extension/public/options.html:20`; `packages/chrome-extension/public/panel.html:23`; `packages/chrome-extension/PRIVACY_POLICY.md` | cumple (publicacion en CWS: pendiente hasta decision de `Data-Unix` y validacion en vivo) |

---

## 2. Avisos de permisos exactos al usuario (Doc 6 — `permissions-list`)

- **`storage`:** No genera ningun aviso de permiso en la pantalla de instalacion de Chrome.
- **`sidePanel`:** No genera ningun aviso de permiso en la pantalla de instalacion de Chrome.
- **`host_permissions` (`http://127.0.0.1/*`, `http://localhost/*`):** En la instalacion muestra un aviso acotado exclusivamente al host local:
  > *"Read and change your data on 127.0.0.1 and localhost"* (*"Leer y modificar tus datos en 127.0.0.1 y localhost"*).
- **`optional_host_permissions` (`http://*/*`):** **No** muestra ningun aviso generico en la instalacion. Solo si el usuario introduce en `Opciones` una IP remota (no loopback) y pulsa Guardar/Probar conexion, `chrome.permissions.request({ origins: ["http://<IP>/*"] })` muestra un dialogo puntual del navegador pidiendo acceso unicamente para esa IP.

---

## 3. Verificacion sobre el bundle final (`dist/`)

Comando ejecutado tras compilar con `esbuild-wasm`:

```powershell
Select-String -Path "chrome-extension/dist/*.js","chrome-extension/dist/*.html" -Pattern "\beval\s*\(|new\s+Function|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|setTimeout\s*\(\s*['`"]|<script[^>]+src=['`"]http"
# Salida:
DIST_FORBIDDEN_HITS=0

Select-String -Path "chrome-extension/dist/*.js","chrome-extension/dist/*.html" -Pattern "https?://[^\s'`")\\]+" -AllMatches |
  ForEach-Object { $_.Matches.Value } |
  Where-Object { $_ -notmatch '^http://(127\.0\.0\.1|localhost|\$\{)' }
# Salida:
DIST_EXT_URL_HITS=0
```

Ademas, `packages/chrome-extension/tests/bundle-audit.test.ts` verifica en cada `npm test` que `dist/` contiene cero patrones prohibidos (`eval(`, `new Function`, `setTimeout("`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `action=set`, `action=start`, `action=stop`, `action=loadmod`, `/fileservice/`, `write_rapid_symbol`, `start_rapid`, `stop_rapid`, `load_module`) y cero URLs externas.

---

## 4. Inventario de dependencias, licencias y `npm audit`

### 4.1 Dependencias de produccion de `mcp-robotstudio` (y subconjunto bundled en la extension)

La extension **no** instala dependencias de runtime externas propias: empaqueta unicamente el cliente `mcp-robotstudio/rws` (sin dependencias de Node ni paquetes criptograficos externos; MD5 RFC 1321 y Digest RFC 7616 propios en `src/rws/md5.ts` y `digest.ts`).

Para el paquete CLI/servidor MCP publico `mcp-robotstudio`:

| Paquete | Tipo | Version en lockfile | Licencia verificada | Script `postinstall` |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | runtime (`mcp-robotstudio`) | `1.32.2` | `MIT` | No |
| `zod` | runtime (`mcp-robotstudio`) | `4.6.7` | `MIT` | No |
| Total dependencias externas de produccion en `packages/package-lock.json` (directas + transitivas) | runtime (97 paquetes) | Ver `packages/package-lock.json` | 100% permisivas: `MIT` (87), `ISC` (7: `inherits`, `isexe`, `once`, `setprototypeof`, `which`, `wrappy`, `zod-to-json-schema`), `BSD-3-Clause` (2: `fast-uri`, `qs`), `BSD-2-Clause` (1: `json-schema-typed`) | No (`hasInstallScript` vacio en prod) |

### 4.2 Dependencias de desarrollo (`packages/package.json`)

| Paquete | Version declarada | Proposito |
|---|---|---|
| `typescript` | `^5.9.3` | Compilacion y typecheck estricto |
| `esbuild-wasm` | `^0.28.2` | Empaquetado MV3 sin binarios nativos ni `postinstall` (`MIT`) |
| `vitest` | `^5.1.0` | Tests unitarios, integracion RWS, E2E MCP y extension |
| `playwright` | `^1.65.1` | Automatizacion Chromium E2E de la extension MV3 |
| `eslint` + `@eslint/js` + `typescript-eslint` | `^10.15.0` / `^10.0.1` / `^8.72.2` | Analisis estatico (`lint`) |
| `@types/chrome` + `@types/node` | `^0.3.7` / `^22.15.0` | Tipado WebExtensions MV3 y Node LTS |

> Nota sobre `hasInstallScript` en `package-lock.json`: unicamente figura `node_modules/fsevents` (dependencia opcional exclusiva de macOS dentro de Vite/Vitest `devDependencies`; no forma parte de las dependencias de runtime ni del tarball de `mcp-robotstudio`).

### 4.3 Resultado literal de `npm audit`

```text
> npm.cmd audit --omit=dev
found 0 vulnerabilities
```

Con `devDependencies` incluidas (`npm.cmd audit`), se reportan unicamente `7 moderate severity vulnerabilities` en el paquete transitivo `minimatch` (`7.0.0 - 11.0.0`) dentro de `typescript-eslint` (solo herramienta de desarrollo, `0 high`, `0 critical`). En `.github/workflows/ci.yml` se verifica `npm audit --omit=dev --audit-level=high`.

---

## 5. Seguridad del paquete npm (`mcp-robotstudio`) y opciones de *Provenance*

Documentacion oficial verificada (HTTP 200):
1. **2FA en la cuenta npm:** https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification — Toda publicacion de paquetes publicos debe requerir 2FA habilitada en la cuenta npm o publicacion de confianza (OIDC).
2. **Atestaciones de procedencia (*Provenance*):** https://docs.npmjs.com/generating-provenance-statements — Permite publicar desde GitHub Actions con `npm publish --provenance` y permiso OIDC `id-token: write`, evitando almacenar tokens npm permanentes en secretos.
3. **Trusted Publishers (OIDC):** https://docs.npmjs.com/trusted-publishers — Vincula directamente el repositorio + workflow + cuenta npm (requiere Node `>= 22.14.0` y npm `>= 11.5.1` en CI).

### Arquitectura de doble repositorio (`Data-Unix/mcp-robotstudio` publico vs. laboratorio privado) — **Provenance y privacidad**

Tanto `npm publish --provenance` como *Trusted Publishers* exigen que el repositorio de GitHub referenciado en `package.json` (`repository.url`) sea **publico**, mientras que el repositorio de desarrollo academico debe permanecer **privado** para proteger material de clase y datos personales del colaborador en entornos locales.

Para resolverlo sin incompatibilidades ni exposicion de datos:

- **Repositorio publico (`Data-Unix/mcp-robotstudio`):** gestionado integramente bajo la cuenta `Data-Unix`, contiene **unicamente** el codigo distribuible (`packages/` y `referencias/rws-rw6-fixtures/`), sin historial academico ni carpetas privadas (`teoria/`, `practicas/`, `agentes/`). `packages/mcp-robotstudio/package.json` apunta ya a `https://github.com/Data-Unix/mcp-robotstudio`, habilitando:
  - **Opcion A (con Provenance / Trusted Publishing):** publicar desde GitHub Actions en `Data-Unix/mcp-robotstudio` via OIDC (`npm publish --provenance`) sin tokens largos almacenados en secretos.
  - **Opcion B (publicacion manual con 2FA):** ejecutar `npm publish --access public` desde la cuenta npm del mantenedor (`Data-Unix`) con 2FA por hardware/OTP habilitada.
- **Control anti-fugas:** `scripts/check_privacy.py` y `scripts/export_public_release.py` validan en CI que ningun artefacto publico contenga rutas `C:\Users\<real>`, identificadores privados ni metadatos del repositorio privado antes de publicar.
