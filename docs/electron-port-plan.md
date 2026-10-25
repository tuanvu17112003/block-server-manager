# Port to Electron + TypeScript + React — approved plan (2026-10-26)

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
