# Block Server Manager

Desktop Minecraft server manager — **Electron + TypeScript + React** (the former Tauri + Rust tree is
dormant reference code archived under `legacy/src-tauri/`; see [ADR-0020](docs/architecture/adr/0020-electron-sole-runtime.md)).

Create and manage Minecraft servers (Vanilla, Paper, Fabric, Forge, NeoForge), install Modrinth and
CurseForge modpacks with a client-mod defense, and operate them: console, players, worlds, backups,
metrics and content management.

## Requirements

- Windows 10/11 x64 (primary target), Node.js 20+ and npm.
- Internet access for version/provider metadata, server/loader downloads and Java (Temurin) provisioning.
- No system Java is required: a matching 64-bit Temurin runtime is downloaded per server when missing
  (Settings/Create can pin a JDK path instead; majors 8/17/21/25 are supported).

## Run

```powershell
npm install
npm run dev        # Vite dev server (1420) + Electron
npm run build      # electron tsc + renderer tsc + Vite build
npm start          # build then launch Electron
```

Browser-only development requires an explicit opt-in mock backend (nothing uses mock data implicitly):

```powershell
$env:VITE_MOCK_BACKEND='1'; npm run dev:web
```

## Verify (do not trust "it builds")

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # agent/DSH shells only
npm run verify       # build + unit + contract + services + lifecycle + management + IPC + real-UI E2E
npm run verify:full  # adds the live engine E2E install matrix (network + Java)
```

Layers, artifacts and manual acceptance: [docs/verification.md](docs/verification.md). UI E2E writes
screenshots under `artifacts/<timestamp>/`.

## Package (Windows)

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm run pack:dir               # build + unpacked app in release/win-unpacked/
npm run pack:verify            # packaged app: --selftest + --mgmttest
npm run pack:win               # NSIS installer in release/
npm run pack:verify:installer  # silent install -> installed self-tests -> silent uninstall
```

The installer is unsigned (SmartScreen "Unknown publisher"), per-user, and keeps app data on uninstall.
Details, artifacts and verification: [docs/packaging.md](docs/packaging.md).

## Data and secrets

- Dev data root: `<repo>/.app-data/`; packaged app: `<userData>/data/`.
- One-shot legacy Tauri import: on first run, if `<APPDATA>\com.blockserver.manager` contains an
  `app.db`, the app imports its servers/backups/history/settings into the JSON store when the target is
  empty (source is left untouched; a marker `legacy-import.json` records the report, and
  `legacy-import-plan.json` is written instead when the target already has servers).
- CurseForge API key: sidebar **⚙ App settings** → CurseForge API key (encrypted with Electron
  `safeStorage`, app-data fallback managed automatically — no file editing). Adding a key enables
  **in-app CurseForge modpack browsing** in Create; keyless Modrinth/CurseForge routes keep working
  without a key. The key is never bundled, logged, or included in support bundles.
- Downloads: **App settings → Downloads & storage** chooses where installer/loader jars, Modrinth and
  CurseForge archives and cached Java zips are written (default `<dataRoot>/cache`). Server folders,
  worlds and backups always stay in the app data root shown there.
- Global preferences (API key, download folder, CurseForge ZIP retention, diagnostics) live in the
  separate **App settings** section; the per-server **Settings** tab only edits that server.

## Project layout

```
electron/        Electron main process (IPC router, services, installer engines, tests under test/)
shared/          Shared contract types (command list + DTOs)
src/             React renderer (tabs, Create wizard modules, store, backend adapters)
scripts/         Verification runner, security audit, packaging verification + build-data checks
docs/            Specs, ADRs, audits, verification + packaging guides, completion plan
build/           App icons used by electron-builder (from the archived Tauri tree)
release/         Packaged output (git-ignored): installer + win-unpacked
legacy/src-tauri/  ARCHIVED Tauri/Rust reference (not built; parity reference)
```

## Documentation map

- [Completion plan + phase log](docs/electron-completion-plan.md)
- [Verification guide](docs/verification.md)
- [Tab/UX spec](docs/specs/app-tabs.md) · [Management/content spec](docs/specs/management-content.md)
- [Playwright MCP real-app test brief](docs/testing/playwright-mcp-test-brief.md) · launcher: `scripts/start-test-app.ps1`
- [Packaging guide (NSIS)](docs/packaging.md) · [Security audit](docs/audit/08-security-audit.md)
- [Architecture overview](docs/architecture/overview.md) · [ADRs](docs/architecture/adr/)
- [Audit reports (evidence + parity)](docs/audit/01-backend-runtime.md)

## Troubleshooting

- **"Backend bridge unavailable"**: the Electron preload failed to load; rebuild (`npm run build`) and
  restart. The app refuses to run on mock data in that state.
- **Port conflict at start**: the configured port is occupied; the start fails closed instead of silently
  changing the port. Choose a free port in Settings (Create uses `port_check` + suggestions).
- **App quit with a running server**: quit performs a bounded graceful stop (5 s) then kills the process
  tree; if a crash left an orphan, the next launch verifies the JVM identity marker before killing it.
- **Java download fails**: check network/proxy; Settings → Java lets you pin an installed 64-bit JDK.
- **Modded server crashes on boot**: managed packs auto-disable attributed client/broken mods and retry;
  unmanaged servers are never modified automatically (see console/crash-report hints instead).
- **SmartScreen warns about the installer**: packaged builds are unsigned; choose "More info → Run anyway"
  or provide a code-signing certificate before public distribution ([docs/packaging.md](docs/packaging.md)).

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
