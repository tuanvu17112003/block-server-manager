# Evidence index — Phase 8 (full verification)

All paths are repo-relative. Regenerate with the gate commands in [docs/verification.md](../verification.md).

## Automated gates (fast, every phase)

| Gate | Result | Artifacts |
|---|---|---|
| `npm run verify` (build, runtime-data, unit, selftest, contract, services, lifecycle, mgmttest, ipctest, uitest) | **PASS 10/10** (2026-10-26) | `artifacts/2026-10-26T14-28-13-635Z/` (summary + logs) |
| Unit (`node scripts/unit.mjs`) | **243/243 pass** | in verify artifacts |
| Contract (`--contracttest`) | PASS — 71 renderer commands = shared tuple = runtime list = handlers; minimal valid payload each | in verify artifacts |
| Service/lifecycle/management/IPC suites | PASS (store, installs, pipeline, backups, content, worlds, players, metrics, lifecycles, 35 management checks) | in verify artifacts |
| Real-UI E2E (`--uitest`, real BrowserWindow + preload + built CSP renderer, seeded backend) | PASS — every tab renders backend data, switching, save-no-flash, delete fallback, Create wizard/catalogue/EULA, **0 renderer errors** | `docs/evidence/phase8-ui/` (**19 screenshots** + console-errors/ui-gaps/ui-pending from the run), latest run in verify artifacts |
| Engine E2E (`--e2e`, real downloads/JVMs) | **PASS 17/17** — vanilla + Paper installs with verified boot, Paper kill→stopped, Modrinth pipeline install+verified boot, cobbleverse boot, CurseForge key-mode SF5 with inferred metadata `forge 1.20.1 47.4.0`, boot Done | [`e2e-engine.log`](e2e-engine.log) |
| Live install matrix (`node scripts/live-matrix.mjs`) | **PASS 9/9** — Java-major/install-major matrix, **live Adoptium Java 21 + Java 25 provisioning** (major/arch verified), live loader catalogue (Paper build 133 STABLE, NeoForge 21.1.265, Forge/Fabric), **live NeoForge installer run**, real CurseForge staging inspection + route-A inference | [`live-matrix.log`](live-matrix.log) |
| Quit-while-running live proof (`node scripts/quitsmoke.mjs`) | **PASS** — real server installed+started (Done), production quit path executed, app exit 0, **0 surviving JVM identity markers** | [`quitsmoke.log`](quitsmoke.log) |
| 24 h soak (`node node_modules/electron/cli.js . --soak --soak-hours=24`) | **in progress** — 1 real managed server kept running while the app churns backups/settings/restarts/kills/metrics reads every 60 s; JSONL per cycle records server status, memory RSS/heap, Electron process working sets, metrics sample count, log-tail availability | `.app-data/soak-*/soak/soak.jsonl` (gitignored; snapshot copied to `artifacts/soak-evidence.jsonl` when complete) |

## What "real-app proof" means here

- `--uitest` opens the actual Electron BrowserWindow with the built `dist/` renderer and preload bridge,
  against seeded real services, and captures page screenshots — not jsdom snapshots.
- `--e2e` installs servers through the production staged transaction and boots real JVMs (Done lines).
- `--quitsmoke` boots a real server inside the app, quits through the production quit path, and an external
  wrapper queries WMI (`-Dtestmultiai.server.id` marker) to prove no orphan java remains.
- The 24 h soak runs the real Electron main process + real JVM continuously, recording memory/handles and
  server status each minute.

## Known limitations recorded honestly

- Mock/browser-mode renderer branches are build-covered only (production/Electron is the enforced path).
- A full Modrinth/CurseForge install **through the UI wizard** is covered indirectly (engine E2E + UI
  wizard DOM checks); it needs a manual click-through with network for an end-to-end UI-install recording.
- 24 h soak completes over wall-clock time; the JSONL is the authoritative record of the window observed.
