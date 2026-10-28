# Verification — how this app is proven working

The project does not accept "build passes" as evidence. One command runs the whole automated gate suite:

```powershell
# from the repository root, nothing else running
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # DSH/agent shells only
npm run verify          # fast gate: build + unit + contract + services + lifecycle + mgmt + ipc + UI E2E
npm run verify:full     # adds the live engine E2E matrix (network + Java)
```

Artifacts (logs, screenshots, `summary.txt`) are written under `artifacts/<timestamp>/`. UI E2E also
writes `console-errors.json`, `ui-gaps.json`, `ui-pending.json` and ~19 screenshots.

## Layers

| Layer | Script step | What it proves |
|---|---|---|
| Build | `npm run build` (electron tsc + renderer tsc + Vite) | type-correct main/renderer, production bundle builds; runtime data copied into `dist-electron` and checked |
| Unit | `node scripts/unit.mjs` (`node:test`) | pure logic: store durability/locking, properties/Java escapes, ZIP reader/writer, archive hardening, Java parsing/provisioning math, versions/loader catalogue mapping, NEOFORGE coordinates, backup retention/plans, world NBT/import planning, player/metrics parsing, diagnostics/redaction, secrets, pipeline decision logic, IPC validators |
| Contract | `--contracttest` | the renderer command list equals the shared contract list; every command has a handler; payload/return DTO shape and `{code,message}` error contract for representative commands; JSON-serialisability of management DTOs |
| Services | `--servicestest` | real services against temp data roots: store, management, pipeline, staged install transaction + verified boot, validation/port/history, backups retention/flush/shutdown, content update/jobs/plugin deps, worlds import/export/delete-safety, players roster/offline ops, metrics history |
| Lifecycle | `--lifetest` | deterministic fake-child lifecycle: duplicate start, stop-during-boot, kill intent, crash-retry, spawn error, EULA fail-closed, port conflict, console validation, bounded tail, fast-ack readiness phases |
| Management gate | `--mgmttest` | end-to-end handler smoke against a temp a root: 35 granular checks incl. backups retention, EULA truth, properties escapes, world dimensions, offline players, metrics validation |
| IPC (renderer) | `--ipctest` | renderer → preload contextBridge → ipcMain round-trip including Create-screen metadata assertions and the sender policy |
| Real UI E2E | `--uitest` | hidden BrowserWindow with the real preload + built renderer, seeded backends: every tab renders real data, server switching, settings save (no shell flash), delete fallback, Create wizard/CATALOGUE/EULA, zero renderer errors; screenshots |
| Engine E2E (`--full`) | `--e2e` | real installs/boots: Vanilla, Paper, Modrinth pipeline (verified boot), CurseForge key-mode server pack with metadata inference; leaves `.app-data` evidence |
| Packaging (unpacked) | `npm run pack:dir && npm run pack:verify` | electron-builder packages `dist/` + `dist-electron/` into an asar; the packaged executable runs `--selftest` and `--mgmttest` successfully |
| Packaging (NSIS) | `npm run pack:win && npm run pack:verify:installer` | real installer is built; silent install into a temp folder, installed app runs `--selftest` + `--mgmttest`, `resources/app.asar` exists, silent uninstall removes it. See [packaging.md](packaging.md) |
| Security audit | `node scripts/security-audit.mjs` | no live secrets in tracked files or any git history diff; sensitive filenames/untracked-secret checks; report [audit/08-security-audit.md](audit/08-security-audit.md) |

## Isolation and environment

- Every gate runs against throwaway `userData`/data roots, so gates can never corrupt the developer's
  `.app-data` (except the explicit `--e2e` matrix, which uses `.app-data` by design and purges `e2e-*`).
- Electron test modes set an isolated profile and skip the single-instance lock, so they can run while
  the app is open, but the gate runner still executes them **serially** — never run two gates in
  parallel against the same data root.
- The DSH/agent shell exports `ELECTRON_RUN_AS_NODE=1`, which makes `electron .` run as plain Node.
  Clear it before launching Electron (the verify runner does this automatically).
- Mock mode is opt-in only: `VITE_MOCK_BACKEND=1 npm run dev:web`. Nothing in production or in the
  Electron app falls back to mock data.

## Manual acceptance (Phase 8)

Run `npm start` (build + Electron) on a machine with Java/network and walk: server list/create Vanilla
and Paper, install a Modrinth pack, start/stop/kill, Console commands, Players/Settings/Worlds/Backups/
Metrics/Content actions, Settings save while running, quit with a running server (no orphan java).
Capture a screenshot per screen and compare with `docs/specs/app-tabs.md`.
