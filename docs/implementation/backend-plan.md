# Backend Plan — From Mocks to Functioning App

Companion to `plan.md` (frontend MVP, DONE). Stack: Tauri 2 + Rust backend + existing React frontend (ADR-0002). Each phase replaces specific mocks in `src/mocks/data.ts`, `src/store.tsx`, `src/tauri.ts:16-23` with real `invoke()` commands. Build in order — each phase unlocks the next. Sources: `docs/research/2026-10-08-minecraft-technical.md` (APIs, Java map, properties), `docs/architecture/overview.md`, `docs/specs/app-tabs.md`, `docs/specs/minecraft-style.md` (IP red lines).

## Binding principles (all phases)
- EULA is NEVER auto-accepted. Backend must refuse `server_start` when `eula.txt` ≠ true, independent of the UI gate (`store.tsx:68-76`).
- RCON binds `127.0.0.1` only, generated password, never logged. Server port opens TCP only for the game port.
- No CurseForge API key ships in the binary — user-supplied key stored in OS keyring (see Phase 5).
- No Mojang assets/fonts/textures bundled (`minecraft-style.md: IP red lines`).
- Every phase: keep UI behaviours (confirms, disabled-when-stopped, empties, toasts, Start pulse); replace mock with backend + loading/error states, never remove the states.

## Phase 0 — Foundations (do first, ships no UI change)
- **Backend:** Rust crate layout `src-tauri/src/{cmds, servers, java, installer, content, rcon, players, worlds, backups, metrics, db, util}`; unified `AppError` (io/http/process/rcon/validation) mapped to toastable `{code, message}`; structured file logging (`logs/launcher.log`, rotation); Tauri event channel `server://log/{id}`, `server://status/{id}`, `job://progress/{jobId}`; path helpers (app-data dir, per-server dir); single-instance plugin; `on_before_exit` hook stub (wired fully in Phase 2).
- **Frontend:** `src/tauri.ts` gains typed `invoke()` wrappers + event listeners feeding the existing store shape; `isTauri()` gates real-vs-mock (dev browser keeps mocks).
- **Accept:** `npm run build` + `cargo check` clean; one smoke command (`ping`) round-trips UI→Rust→UI.
- **Risk:** Rust toolchain setup on Windows (MSVC); pin versions in README.

## IPC surface (final — implement incrementally per phase)
| Command | Phase | Replaces |
|---|---|---|
| `ping` | 0 | smoke test |
| `servers_list/create/delete`, `server_get` | 1 | `initialServers`, `addServer` (`store.tsx:142`) |
| `java_detect`, `java_ensure(version)` | 3 | "Java Auto" text |
| `versions_vanilla`, `versions_paper`, `loaders_resolve` | 4 | version dropdown mocks |
| `modpack_search`, `modpack_get`, `modpack_install` (+`job://progress`) | 4–5 | `src/mocks` pack cards, install progress mock (`Create.tsx`) |
| `server_start/stop/kill/restart`, `server_send_command` | 2, 6 | `tauriServer.*` stubs (`tauri.ts:17-20`), fake start/stop timers (`store.tsx:81-99`), fake replies (`store.tsx:128-133`) |
| `logs_tail`, `logs_clear` | 6 | `initialLogs`, ambient tick (`store.tsx:44, 156-176`) |
| `players_list`, `player_action`, `player_add` | 7 | players mock table |
| `worlds_list/import/activate/create`, `server_files` (properties/icon read-write) | 8 | worlds + settings mocks |
| `backup_now/list/delete/download`, `backup_restore`, `backup_config` | 8 | backups mock + progress mock |
| `metrics_snapshot`, `metrics_history` | 9 | jitter tick (`store.tsx:157-176`), static series |
| `app_check_update` | 10 | — (new) |
| Events: `server://log/{id}`, `server://status/{id}`, `server://players/{id}`, `job://progress/{jobId}`, `metrics://tick/{id}` | 2, 6, 8, 9 | timers + `setTimeout` simulations |

## Data model
- **Per-server folder** `<app-data>/servers/<id>/`: `server.jar`, `mods/`, `world/`, `world_nether/`, `world_the_end/`, `server.properties`, `eula.txt`, `server-icon.png`, `whitelist.json`, `ops.json`, `banned-players.json`, `banned-ips.json`, `logs/`, `backups/` (or central `backups/<id>/`), `installer.log`.
- **SQLite** (`app.db`, later): `servers(id, name, loader, mc_version, loader_version, modpack_id, port, ram_mb, java_path, eula_accepted, status, created_at)`, `backups(id, server_id, name, kind, size_mb, path, created_at, note)`, `worlds(id, server_id, name, path, size_mb, seed, active)`, `jobs(id, kind, progress, log)`, `settings(key, value)` (CF key reference only — secret lives in keyring).

## Phase 1 — Persistence (servers CRUD)
- **Backend:** SQLite open + migrations; `servers_list/create/delete`, `server_get`; per-server folder scaffold on create; port allocator (auto 25565+, conflict vs DB + live probe).
- **Frontend:** sidebar list + `addServer`/`select` read from DB; `usedPorts` (`store.tsx:198`) from `servers_list`; delete-server UI (confirm, in Settings danger zone — small UI addition, PQM-approved as required by flow).
- **Accept:** restart app → servers persist; duplicate-name and port-conflict rejected with toasts; EULA still blocks start.
- **Risk:** schema changes later — keep migrations from day one.

## Phase 2 — Process manager
- **Backend:** spawn `java` with per-server flags; reserve a server ID before spawn; track PIDs; `server_start/stop/kill/restart`; exit-code + crash detect → `crashed` status + banner; stdout/stderr → `server://log` events; stdin write for commands; stop-all in `on_before_exit`; kill orphaned PIDs on launch (stale lockfile) only after positive process-identity verification of the saved provider-specific launch shape plus marker; reject the start if tracking/lockfile setup fails and clean up the spawned child.
- **Frontend:** remove fake process timers/replies on the Tauri path (`store.tsx:81-99, 105-109, 112-119`); load/create persisted records through strict IPC when `isTauri()`; show a retryable error state if the persisted list fails to load; use status/log events; keep in-memory mocks in browser mode; preserve Start pulse and EULA gate.
- **Accept:** start→starting→running with real logs; concurrent starts for one server create at most one child; stop graceful; kill/exit cleanup covers Windows descendants; failed tracking setup does not leave an untracked process; orphan recovery fails closed unless the recorded server identity matches; crash shows red banner; restart works end-to-end (Vanilla only — modded needs Phase 4); Tauri lifecycle IDs come from `servers_list/create`, and a fresh empty database opens the global Create view without a mock server ID and keeps its completion state mounted until the user chooses Go to Console.
- **Risk:** Windows PID reuse and process trees (see [`2026-10-08-phase2-process-safety.md`](../research/2026-10-08-phase2-process-safety.md)); log backpressure (cap buffer, drop-oldest), path spaces/long paths.

## Phase 3 — Java provisioning
- **Backend:** `java_detect(mc_version)` checks PATH, `JAVA_HOME`, Windows JavaSoft registry entries, and known Adoptium/Microsoft OpenJDK locations, then validates each `java.exe` major and 64-bit architecture. Resolve MC requirements from Mojang version JSON `javaVersion.majorVersion`; for a known version, use the documented fallback only when that field is absent or Mojang metadata cannot be reached because of a network failure or HTTP 5xx response. Available metadata is authoritative: malformed metadata, an unknown version, HTTP 4xx, and explicit unsupported Java majors fail without fallback. `java_ensure(major)` downloads the Windows x64 Temurin JDK ZIP for supported majors 8/17/21, checks available disk space, resumes the checksum-keyed partial archive when HTTP Range is honored, verifies the Adoptium SHA-256, and installs under app data without changing global environment/registry state. Persist a validated `java_path` per server. `server_start` uses a local Java requirement mapping for each version in the current Create catalogue and validates Java locally; it never requests Mojang metadata or waits on Mojang network access. Unknown Minecraft versions fail closed until their local mapping is added.
- **Frontend:** Create and Settings show the required/selected Java major and source; Install/Use Temurin and Change… path override controls expose real download progress. Keep browser mocks and error toasts.
- **Accept:** clean Windows install resolves Mojang metadata and installs Java 8 for 1.12.2, Java 17 for 1.20.1, and Java 21 for 1.21; Java paths persist per server; a runtime below the requirement or not 64-bit is rejected with a clear message.
- **Scope boundary:** Current Create catalogue ends at 1.21 and Phase 3 supports 8/17/21. Minecraft 26.1 requires Java 25; any future catalogue that includes 26.1 must add Java 25 provisioning before exposing that version. Unknown/unsupported metadata majors fail closed.
- **Risk:** Temurin packages are large; range support is optional and must be checked by the downloader; disk space may change after preflight; ARM Windows is outside this x64 Phase 3 scope.

## Phase 4 — Vanilla + Paper + loader installs
- **Research/spec:** `docs/research/2026-10-08-phase4-server-installs.md`, `docs/specs/server-installs.md`, `docs/implementation/phase4-server-installs.md`, ADR-0004.
- **Boundary:** Windows x64; keep the existing seven MC versions supported by Phase 3 (1.12.2, 1.18.2, 1.19.2, 1.20.1, 1.20.4, 1.20.6, 1.21), Java 8/17/21; intersect live provider metadata with that catalogue. Do not expose 26.1/Java 25 in this phase.
- **Backend:** Mojang piston-meta → version JSON → `server.jar` (size/SHA1 verify); Paper Fill v3 STABLE-only builds (size/SHA256); Fabric/Quilt compatible metadata and server installers; Forge recommended/latest promotions; NeoForge Maven installer with unambiguous documented MC mapping. Capture `installer.log`; resolve compatible MC×loader combos (`loaders_resolve`); generate the minimal `server.properties`; EULA stays false unless explicitly accepted by the Create checkbox. Stage files first and persist only after artifact and process-launch validation. The process manager gains provider-aware start arguments for Forge/NeoForge so every published install remains managed by the same PID/log/stdin/stop lifecycle.
- **Frontend:** Create wizard version picker uses `versions_vanilla`/`versions_paper` and `loaders_resolve`; install view shows truthful byte/stage progress, installer log, Cancel (terminate process + clean staging), Retry, and the existing completion action. Browser mocks remain. Tauri modpack install stays unavailable until Phase 5 and cannot claim mock success.
- **Accept:** Vanilla + Paper + Fabric server installs end-to-end from UI; all planned providers expose only compatible versions and can start/stop through the managed process lifecycle; Quilt validates both its launcher and nested server JAR; failed/canceled install leaves no server record or partial server directory; unavailable loader choices never silently submit Vanilla; EULA is never auto-accepted.
- **Risk:** Forge promotions are not a full build list; installer formats drift; loader installers may not expose byte progress; provider results and compatibility must be revalidated at install time. Modrinth client-only manifest filtering is handled with Phase 5 pack extraction.

## Phase 5 — Modpack sources (Modrinth-first, CurseForge-gated)
- **Backend:** Modrinth v2 search/project/version/download (open, `User-Agent` header, 300/min etiquette); CurseForge v1 behind user key (keyring storage, settings field, rate-limit + friendly "key required" state); `.mrpack` (Modrinth format) + CF manifest extraction; dependency resolution; `modpack_install` as cancellable job.
- **Frontend:** search tabs default Modrinth, CF tab explains key requirement; pack cards from live data (skeleton retained); version dropdown + changelog from API.
- **Accept:** top Modrinth packs install 1-click; CF without key shows setup hint, with key works; client parity notice kept.
- **Risk:** CF ToS/approval for key issuance; CDN URL expiry; pack sizes in GB.

## Phase 6 — Console (real logs + commands)
- **Backend:** `logs_tail` reads bounded `logs/latest.log` history alongside the existing live events; use read-only rotation-tolerant tailing on Windows. `server_send_command` sends only through tracked stdin for this phase and persists the newest 100 successful commands per server in SQLite. Detached RCON is deferred by ADR-0011 until a supported cross-loader loopback-only bind mechanism is verified; keep RCON disabled.
- **Frontend:** remove fake replies (`store.tsx:128-133`) and ambient tick for logs; keep search/level filter, auto-scroll, Clear/Export (export = real file download), quick chips (`save-all`, `say`, time/weather), Kill confirm.
- **Current task scope (backend-019, user-approved 2026-10-10):** backend only. Frontend behavior and Clear remain unchanged; Clear does not truncate the server-owned log file. Backend history is exposed for a later frontend wiring task.
- **Accept:** tracked `list` reaches the server and `say` appears in game; history requests return bounded tail lines; successful commands appear in per-server persisted history; log search over 10k+ lines stays smooth (virtualize if needed).
- **Risk:** log throughput on busy modded servers — cap + drop-oldest + "skipped N lines" notice.

## Phase 7 — Players
- **Backend:** read/write `whitelist.json`/`ops.json`/`banned-*`; live-apply via RCON (`whitelist/op/deop/ban/pardon/kick`), file-edit when stopped; Mojang name→UUID resolve (cache); offline roster from `usercache.json` + playerdata (MVP: usercache + lists only, NBT later).
- **Frontend:** table wired; row actions confirm + need-running tooltips (kept); Add-player works offline.
- **Accept:** OP/whitelist/ban round-trips verified in-game; stopped-server edits apply on next start.
- **Risk:** Mojang API rate limits (cache UUIDs); cracked `online-mode=false` breaks UUID mapping — keep existing warning.

## Phase 8 — Worlds, backups, settings/files
- **Backend:** world discovery (`level.dat` scan), `worlds_activate` (stopped-only, auto-backup first), import `.zip` (validate `level.dat`), new world (seed/level-type); `backup_now` (save-off/flush/zip/save-on, progress events), schedules (interval/cron/on-stop), retention prune, `backup_restore` (stop→validate→replace, in-place vs reset), download; `server.properties` subset read/write + validation + restart-required flag; `server-icon.png` 64×64 validate.
- **Frontend:** remove worlds/backups/settings mocks; keep Activate confirm, Restore confirm, dirty-check, cracked-mode warning.
- **Accept:** backup→delete world→restore round-trip; scheduled backup fires; invalid properties rejected with field error.
- **Risk:** backup disk growth (default keep-7 + size cap); world-folder locks on Windows; always backup before loader updates.

## Phase 9 — Metrics (real)
- **Backend:** process CPU/RAM (per-PID), disk usage, uptime; players via RCON `list`/Query; TPS/MSPT only where available (Paper `tps`, spark) else `null` → existing "needs RCON" hint; 1-min samples, 7-day retention, range queries.
- **Frontend:** remove jitter (`store.tsx:157-176`) and static series; live cards + graphs from `metrics_snapshot/history`; empty-when-stopped kept.
- **Accept:** numbers match Task Manager within noise; stopped server shows empty state, not zeros.
- **Risk:** polling cost with many servers — poll active only, throttle background.

## Phase 10 — Update, polish, harden
- **Backend:** `app_check_update` via `tauri-plugin-updater` (`latest.json`, signed NSIS); `src-tauri/` + `tauri.conf.json` (dev port 1420, WebView2 bootstrapper, file/dialog/shell capabilities least-privilege); secret audit (no CF key/RCON password in logs or bundles); firewall guidance text for first game-port bind.
- **Frontend:** update-available toast + restart-to-update; remove `console.debug` stub logging (`tauri.ts:10-14`); empty-state and error-retry pass over all tabs.
- **Accept:** clean install → create Vanilla → start → join from LAN client; update flow works; full regression (checklist top-to-bottom).
- **Risk:** updater key management; SmartScreen reputation on unsigned first releases.

## Test strategy (every phase)
- New: backend unit tests per module (Rust `cargo test`) + one UI happy-path check.
- Regression: `npm run build` + `cargo check` + full checklist skim; re-run prior phases' accept criteria when touching shared code (process manager, DB, IPC types).
- Mocks stay for browser-dev (`isTauri()` fallback) until Phase 10; mark each replaced mock with `// backend-wired` so Reviewer can verify none fake remains at the end.
