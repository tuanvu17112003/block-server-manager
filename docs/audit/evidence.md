# Evidence log — baseline verification and independent probes (2026-10-26)

All commands were run by the Lead on this machine (`H:\TESTMultiAI\20`, Windows, Electron 45 / Node 24.22 bundled). Nothing in this file is inferred from the audit reports; it is the ground truth used by `docs/electron-completion-plan.md`. The audit reports (`01`-`05`) contain the static evidence and file:line citations.

## 1. Environment note (test-harness prerequisite)

The DSH shell inherits `ELECTRON_RUN_AS_NODE=1`. Any `electron .` invocation then runs the bundled binary as plain Node, which fails with `TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')` and makes every gate exit 1. Clearing the variable before running fixes the gates:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

Every gate script/CI wrapper must clear it (and refuse to run when Electron is already running — see §2.5).

## 2. Project gates at baseline (working tree, uncommitted management wave)

Run serially (all Electron test modes share the single-instance lock and/or `.app-data`).

| Gate | Command | Result |
|---|---|---|
| Full build | `npm run build` | **PASS** — tsc (electron + renderer) clean, vite build 303 kB JS |
| Selftest | `npm run selftest` | **PASS** — `ping=pong | create=… | list>=1=true | setJava=true | get=true | delete=true | error-code=true` |
| Management smoke | `npm run mgmttest` | **PASS 17/17** (create, settings-update/read, list enrichment, worlds list, backup create/restore/delete, world duplicate/delete/pending, content list/toggle/remove, settings validation, players stopped, metrics history, error codes, delete cleans disk) |
| Real IPC/renderer smoke | `npm run ipctest` | **PASS** — renderer→preload→ipcMain chain, error envelope `{code:'not-found'}`, 3 Create-screen UI assertions, writes `ipc-result.txt`/`ui-smoke.png` into the dev data root |
| Engine E2E | `electron . --e2e` | **PASS 12/12** — ping, Vanilla 1.21.1 install/start `Done (…)`/stop, Modrinth cobbleverse preview/install/start/stop, CF SkyFactory-5 key-mode one-click download (281 MB, shipped Forge installer) + boot `Done (6.696s)!`, staged-zip inspect |

**Interpretation:** the gates are green while the P0 defects below are present → the gates do not represent user-visible correctness (see B-25; no failure/cancel/UI-render/negative coverage; they also mutate `.app-data` and can silently pass when another instance holds the lock).

## 3. Independent UI probe (real renderer + real IPC wiring, throwaway data root)

Harness: `electron` launched with a one-off script that wires the production handlers, seeds one stopped Vanilla 1.21.1 server (properties motd/max-players=10, world, mod, backup, pending world), loads `dist/index.html` with the real preload, walks every tab and the Create wizard, captures screenshots. Script was scratch (not shipped); screenshots kept in `docs/audit/evidence/`.

Result: **no renderer errors** (only Electron's dev CSP warning), every tab rendered, Create wizard reached Configure with 920 Mojang versions, Java requirement resolved, loader select populated transiently.

| Check | Result |
|---|---|
| Servers hydrate from backend | PASS |
| Tabs Overview/Console/Content/Players/Worlds/Backups/Metrics/Settings render | PASS (`ui-overview.png`, `ui-settings.png`, `ui-worlds.png`) |
| Create wizard → Vanilla → Configure | PASS (`ui-create-configure.png`); Java required: 17; port free hint |
| Backend handlers for settings/worlds/backups/players/content/metrics/logs/history/versions/loaders | PASS (DTOs listed below) |
| `loaders_resolve('1.21.1')` | **Vanilla, Paper, Fabric, Forge — NeoForge MISSING** (live) |
| `players_list` maxPlayers vs `server_settings_get` max-players | **20 vs 10 — API-contract mismatch** (live; the UI ignores the field, so no visible mismatch — see M-06) |
| `world_create` pending flow | pending world listed active + `next start`, `level-name` changed |

## 4. Targeted live probes (cheap, falsifiable)

1. **Paper install (P0):**
   `installLoader('paper', tmpdir, '1.21.1', '', java, cache)` → `PAPER_INSTALL_ERR: loader not supported: paper`.
2. **NeoForge resolution (P1):** live `https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml` for MC 1.21.1 publishes `21.1.253…21.1.265`; `versions.ts` filters by prefix `1.21.` → never matches. Legacy `net/neoforged/forge` still uses `1.20.1-47.1.10x` (works for 1.20.1 only).
3. **Paper catalogue mapping (P1):** live Fill v3 `support.status` for 1.21.1/1.20.4/1.21 is `UNSUPPORTED` (lifecycle, not channel) and each has 100+ `STABLE` builds; `versions.ts` maps any non-`SUPPORTED` status to `versionType:'snapshot'`, and `Create.tsx` hides non-release versions unless "Show snapshots" is enabled.
4. **Java DTO drift (P1):** `java_detect` returns candidates `{major, javapath, source}`; renderer `JavaCandidate` expects `{path, major, architectureBits, source}` (Create/Settings read `.path`).
5. **Store lost-update (P1) — proven with two instances:**
   ```
   s1=new Store(root); s2=new Store(root);        // s2 is the shared process-manager instance
   s1.createServer({name:'A'}); s2.pushCommand('x','say hi');
   new Store(root).listServers() === []            // LOST_UPDATE_CONFIRMED — server A erased
   ```
6. **Duplicate ports in dev data:** `.app-data/app-data.json` lists 2 servers both on port 25565 (no allocator/unique port).
7. **Orphan server directories:** `.app-data/servers` contains 8 folders vs 3 records — failed/cancelled installs and deleted records leave directories (B-09/M-16).
8. **Handler coverage:** live handler-map dump = 65 commands; renderer `src/tauri.ts` invokes 65 distinct commands; Rust registered 35 → all Rust names present, no renderer command without a handler. Drift is in payloads/semantics, not names.
9. **Corrupt-ZIP extractor probe (management-audit teammate, read-only Node against `dist-electron`, temp root):** flipping one deflate byte makes `extractZip` raise `UNCAUGHT EXCEPTION: Z_DATA_ERROR invalid code lengths set`; the extraction promise remains pending after 4 s and a 0-byte partial file is left behind (M-17, P0). Reproduced independently of the gate suite.

## 5. Explicitly not verified at baseline (needs the new runtime gates)

- Real Modrinth/CF install **through the Create UI** (engine E2E bypasses the renderer; the report-shape crash `F-01` is on that screen).
- Quit-with-running-server process survival (the one-off quit probe was interrupted before producing output; code path is unambiguous in `main.ts:119-121`).
- Cancel behaviour during download/loader install.
- Data migration from a real Tauri `%APPDATA%\com.blockserver.manager` install (no fixture exists on this machine; legacy prototypes exist under `%APPDATA%\minecraft-server-manager`).
- Windows process-tree kill, PID-reuse reap accuracy, 10 MB console tail latency, backup flush behaviour on a busy world, metrics CPU accuracy vs Task Manager.
