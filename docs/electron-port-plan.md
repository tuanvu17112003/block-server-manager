# Port to Electron + TypeScript + React — approved plan (2026-10-26)

> **STATUS (2026-10-26, Phase 7): port complete.** This document records the originally approved port
> scope; it is historical. Current truth lives in:
> - [completion plan + phase log](electron-completion-plan.md) — Phases 0–6 done, 7 in progress, 8 pending
> - [verification guide](verification.md) — gates and evidence
> - [audit reports](audit/01-backend-runtime.md) — findings/parity/evidence
> - [ADR-0020](architecture/adr/0020-electron-sole-runtime.md) — Electron is the sole runtime; the Tauri
>   tree is dormant and `frontend-export/` was retired. The command surface is now 71 renderer commands.

Port "Block Server Manager" from Tauri (Rust backend, dormant after port) to Electron with a
Node/TS main process, then integrate the proven modpack install modules
(`H:\TestAI\modrinth-curseforge\sample` — 12/12 live PASS, 4-layer client-mod defense, CF key-mode).

**User decisions:** JSON store (no SQLite) · `src-tauri/` kept dormant.

## Architecture

```
electron/                 # main process (TypeScript, CommonJS out → dist-electron/)
  main.ts                 # window 1280x800 sandbox+contextIsolation; dev URL or dist/; --selftest mode
  preload.ts              # contextBridge electronAPI: invoke(command,args), on(channel,cb), pickers, openExternal
  ipc.ts                  # command router (same 35 command names as Rust), errors as {code,message} JSON-in-message
  services/
    store.ts              # <dataRoot>/app-data.json atomic JSON (servers/settings/history)
    java.ts               # detect/validate/ensure (Adoptium), Mojang-metadata java-major mapping
    versions.ts           # piston-meta vanilla, fill.papermc.io v3 paper, loaders_resolve
    server-process.ts     # java child supervision, ring buffer, server://log|status events
    installer/            # TS port of sample core/modrinth/curseforge + data (itzg lists, env-overrides)
    pipeline.ts           # installer ⇄ PipelinePreviewDto/PipelineInstallResult mapping (fileDecisions = L1+L4)
    jobs.ts               # job registry + AbortController, job://progress/{id}
    curseforge-staging.ts # embedded BrowserWindow + will-download staging; list/pick/inspect; key-mode one-click
src/
  tauri.ts                # + isElectron() branch ahead of Tauri/HTTP (same exported surface)
  backend/config.ts       # skip HTTP config fetch when window.electronAPI present
```

Event channels identical to Rust (`server://log/{id}`, `server://status/{id}`, `job://progress/{id}`,
`curseforge://download`). Data root: dev `<project>/.app-data`, prod `userData`.
CF key: `<dataRoot>/curseforge-key.txt` (gitignored, never logged).

## Phases
- **P0 Shell** — electron scaffold, JSON store CRUD (ping, servers_*), adapter branch, scripts
  (`dev`=vite:1420+electron via wait-on, `build`, `start`), remove `@tauri-apps/cli`, `--selftest` gate, commit.
- **P1 Runtime** — java_*, versions_*, loaders_resolve, server_install(+cancel) w/ `Done (` verify,
  server lifecycle + events + logs_tail + history.
- **P2 Modules** — installer TS port; modrinth_search/project_versions; modpack_pipeline_* (preview
  decisions, install, cancel); curseforge staging browser + inspect + key-mode one-click.
- **P3 E2E via real UI** — vanilla create→start→stop; Modrinth cobbleverse wizard; CF skyfactory-5
  one-click; persistence across restart.

## Non-goals
Real backups (stay stubbed), Worlds/Players/Metrics backends (mocks), NSIS, auto-update.
Cut-line if needed: embedded CF browser (external-browser fallback already works).

Source-of-truth for install behavior: `H:\TestAI\modrinth-curseforge\modpack-install-results.md`
and `client-mod-method-research.md` (4-layer architecture).

---

## Completion (2026-10-26)

**Status: PORT COMPLETE — E2E PASS (exit 0), 12/12 steps.**

| Phase | Commit | Gate |
|---|---|---|
| P0 shell (electron main/preload/ipc, JSON store, adapter branch) | a391ff1 | SELFTEST PASS |
| P1 runtime (engine TS port, java/versions/loaders/install, lifecycle events) | e7c6581 + ccb71d2 | versions/loaders smoke green (5 loaders, neoforge legacy coordinate) |
| P2 module integration (modrinth/curseforge engines, pipeline+rollback+sidecar, CF staging browser, boot L2/L3) | da3ab4a | tsc clean + modrinth search smoke |
| P3 E2E | (this commit) | **E2E PASS**: ping · vanilla install→`Done`→stop · Modrinth cobbleverse search→preview→install→`Done`→stop (wizard's exact path) · **CF key-mode one-click SF5** (serverPackFileId → 281MB pack → `Done (6.256s)!`) · staged-zip inspect |

Real bugs the E2E caught and fixed (all generic, none per-pack):
1. **Store instances held stale in-memory state** across handler construction → read-through store (reload on every access).
2. **`server_start` awaited process lifetime** (never resolved while the server ran) → spawnWatch split into `started` / `exited` promises; start returns on `Done(`.
3. **No startup timeout** → 10-min boot watchdog → kill + `crashed` (spec §5).
4. **Loader installer transient network failure** (SSL EOF) killed installs → one retry (§19.2).
5. e2e harness itself: leftover records/processes (idempotent purge), buffered stdout on `app.exit` (file-based results), verdict regex.

Run it: `npm run dev` (vite:1420 + electron), `npm start` (build + app), `npm run selftest`, `electron . --e2e`.
Key data: `.app-data/` (dev data root, gitignored) · `.app-data/curseforge-key.txt` (key-mode, gitignored).

---

## Management + content completion (2026-10-26)

The P0–P3 port kept Players/Worlds/Backups/Metrics/Settings as mocks and listed Worlds/Players/Metrics backends,
real backups, and content browsing as non-goals. Those gaps are now implemented in the Electron backend:

- `properties.ts` — typed `server.properties` parse/merge/validate, EULA file, settings DTO hydration,
  real port availability (`port_check`), open-folder.
- `players.ts` — roster from `ops/whitelist/banned/usercache`, live `list` reply, last-seen/playtime from
  `logs/latest.log`, op/deop/whitelist/kick/ban/pardon/gamemode/teleport/heal, Mojang name lookup.
- `worlds.ts` — level.dat scan, activate with auto-backup, create-for-next-start, duplicate, delete with
  safety backup, export/import ZIP (bounded extraction).
- `backups.ts` — real deflated ZIP archives (`zip.ts`), save-off/flush when running, restore with
  pre-restore copy + rollback, retention, export/delete, interval scheduler.
- `metrics.ts` — 2 s process sampling (CPU delta, working set, uptime), `metrics://{id}` events, `list`
  polling for players, Paper TPS/MSPT when present, 1-minute history persisted 7 days, disk probe.
- `content.ts` + Content tab — installed mods/plugins, reversible enable/disable, remove, Modrinth search,
  compatible versions, install with required dependencies, pre-update backup.
- Console persistence — `logs/msm-console.log` (10 MB rotation) backs `logs_tail` after restarts;
  command history reloads per server; `-Xms` matched to `-Xmx`.
- Boot safety — `.msm-server.pid` identity file, orphan Java reaping (only a live `java` image is
  killed), live statuses normalized to `stopped`, and persisted ports reconciled before spawn.

Modrinth/CurseForge parity checked against `H:\TestAI\modrinth-curseforge`:

- **CurseForge route B** (client pack ZIP via `manifest.json`) is now accepted by preview/install; the UI
  labels it “Client pack — manifest install” instead of refusing it.
- **Official API key one-click** — project URL/slug/id → latest file → `serverPackFileId`; exposed in the
  Create wizard and by `curseforge_inspect_project`.
- **L3 dependency fetch** — missing hard dependencies reported by the loader are resolved from Modrinth
  (project id/slug, filtered by MC version + loader) before any jar is disabled.

Gates: `npm run build` clean · `npm run ipctest` PASS (renderer → preload → ipcMain, plus Create UI
smoke) · `npm run mgmttest` PASS 17/17 · `npm run selftest` PASS · `electron . --e2e` PASS 12/12
(vanilla, Modrinth cobbleverse, CF SF5 key-mode).

**IPC wiring fixed (2026-10-26):** `registerIpc()` used to run before `registerRuntimeHandlers()`;
because it snapshots the handler map, every runtime command was absent from `ipcMain` and the UI
showed `No handler registered` for versions/loaders/java. Wiring now runs runtime-merge → bind,
`registerIpc` refuses a second call, and `--ipctest` drives the real preload/BrowserWindow path.
Command errors now use a preload-unwrapped envelope, so toasts keep `{code,message}` instead of
Electron's `Error invoking remote method ...` prefix.

Still deferred (not part of the Tauri feature set): playit.gg orchestration, schedules beyond backups,
i18n, auto-update, full files editor, RCON.
