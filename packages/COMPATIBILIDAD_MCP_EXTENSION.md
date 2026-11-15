# Matriz de compatibilidad MCP / extensión (en vivo)

Controlador http://127.0.0.1:80, 2026-11-15T22:58:46.756Z. Servidor MCP v0.2.0 en solo lectura; extensión 0.2.0 cargada por CDP con licencia de laboratorio.

| Módulo | Herramienta MCP | Acción de la extensión | Igual | MCP | Extensión |
|---|---|---|---|---|---|
| rws (client) | `get_controller_state` | `getDashboardData` | sí | IRB120_3_58 / 6.16.3007 / motoron / AUTO / stopped / T_ROB1 | IRB120_3_58 / 6.16.3007 / motoron / AUTO / stopped / T_ROB1 |
| rws (client) | `list_modules` | `getDashboardData.modules` | sí | user,BASE,CalibData,Practica63_Final | user,BASE,CalibData,Practica63_Final |
| rws (client) | `list_signals` | `getSignals` | sí | 66 signals | 66 signals |
| rws (client) | `get_event_log` | `getDashboardData.events` | sí | 10125@2026-11-15 T 23:27:04,10156@2026-11-15 T 23:25:33,10053@2026-11-15 T 23:25:33 | 10125@2026-11-15 T 23:27:04,10156@2026-11-15 T 23:25:33,10053@2026-11-15 T 23:25:33 |
| rws (client) | `read_rapid_symbol CalibData/MyTool` | `readSymbol` | sí | [TRUE,[[31.7926,0,229.639],[0.945519,0,0.325568,0]],[1,[0,0,1],[1,0,0,0],0,0,0]] | [TRUE,[[31.7926,0,229.639],[0.945519,0,0.325568,0]],[1,[0,0,1],[1,0,0,0],0,0,0]] |
| rws (client) | `read_rapid_symbol Practica63_Final/pInterrupcion` | `readSymbol` | sí | [[340,130,235],[2.35691E-9,-1.64583E-11,-1,1.66103E-9],[0,-1,0,0],[9E+9,9E+9,9E+9,9E+9,9E+ | [[340,130,235],[2.35691E-9,-1.64583E-11,-1,1.66103E-9],[0,-1,0,0],[9E+9,9E+9,9E+9,9E+9,9E+ |
| rws (client) | `read_rapid_symbol Practica63_Final/nPasadasArray` | `readSymbol` | sí | 1 | 1 |
| rws (client) | `read_rapid_symbol BASE/tool0` | `readSymbol` | sí | [TRUE,[[0,0,0],[1,0,0,0]],[0.001,[0,0,0.001],[1,0,0,0],0,0,0]] | [TRUE,[[0,0,0],[1,0,0,0]],[0.001,[0,0,0.001],[1,0,0,0],0,0,0]] |
| rws (client) | `get_joints` | `getTelemetryPro.joints` | sí | [33.2446937561035,3.34342312812805,27.9934749603271,-39.7877159118652,31.8308296203613,62. | [33.2446937561035,3.34342312812805,27.9934749603271,-39.7877159118652,31.8308296203613,62. |
| rws (client) | `get_tcp` | `getTelemetryPro.tcp` | sí | [303.6731,170,405.5315,0.3255681,7.870087e-14,0.9455186,6.091136e-14] | [303.6731,170,405.5315,0.3255681,7.870087e-14,0.9455186,6.091136e-14] |
| rws (client) | `get_program_pointer` | `getTelemetryPro.pcp` | sí | Practica63_Final/main:87 | Practica63_Final/main:87 |
| rws (client) | `get_speed_ratio` | `getTelemetryPro.speedRatio` | sí | 100 | 100 |
| kinematics | `(checkJoints via get_joints)` | `getTelemetryPro.safety` | sí | w=1.3226e-2 /J5/=31.831 | w=1.3226e-2 /J5/=31.831 |
| rws (client) + mechunit | `-` | `getFleet.smbSync` | sí | IRB120_3_58 | IRB120_3_58 Synchronized |
| rws (client) | `read_module_source` | `readModuleSource` | sí | 5107 chars | 5107 chars |
| rapid/diff | `diff_module_with_golden` | `panel Time-Machine Diff (same lib)` | sí | +4/-4 | +4/-4 |
| rapid/validator | `validate_rapid_offline` | `panel validator (same lib)` | sí | errors 0 warnings 0 | errors 0 warnings 0 |
| forensics | `capture_forensic_blackbox` | `captureForensic` | sí | none pp=87 | none pp=87 |
| recipes (shield) | `write_rapid_symbol shield (no write)` | `checkRecipeWrite (same lib)` | sí | blocked expected | TCP jump 200.0 mm exceeds delta_max 50 mm |
| kinematics (StorePath cert) | `read_rapid_symbol x2` | `getStorePathCert` | sí | 0.4554 mm | 0.4554 mm |
| practice (live audit) | `read_rapid_symbol CalibData/MyTool` | `getLiveAudit.tools` | sí | [TRUE,[[31.7926,0,229.639],[0.945519,0,0.325568,0]],[1,[0,0,1],[1,0,0,0],0,0,0]] | [TRUE,[[31.792631019,0,229.638935148],[0.945518576,0,0.325568154,0]],[1,[0,0,1],[1,0,0,0], |
| rspag (audit) | `audit_rspag_package` | `rspag-worker audit` | sí | ok {7A8BF1E4-734F-4AE3-848F-F8433D77861B}/{7351C77F-478C-4197-89E4-DB4C9872CE2D} privacy=0 | ok {7A8BF1E4-734F-4AE3-848F-F8433D77861B}/{7351C77F-478C-4197-89E4-DB4C9872CE2D} privacy=0 |
| rws (dialect) | `stderr dialect=auto->rws1` | `client.dialect (telemetry)` | sí | rws1 | rws1 |

Resultado: 23/23 iguales.
