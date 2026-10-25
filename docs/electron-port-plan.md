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
