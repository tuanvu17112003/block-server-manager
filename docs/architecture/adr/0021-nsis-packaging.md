# ADR-0021 — Windows NSIS installer (electron-builder, unsigned, per-user)

- Status: Accepted (2026-10-28)
- Context: Phase 8 verification is complete and the app previously ran only from source
  (`npm start` / `electron .`). The product needs a distributable Windows installer without adding an
  auto-update service or code-signing pipeline yet (the deferred items in the completion plan).

## Decision

1. Package with **electron-builder** (`electron-builder.yml`) targeting a Windows **NSIS** installer,
   x64, from the existing Electron + TypeScript + React tree.
2. The installer is **per-user** (`perMachine: false`), assisted (`oneClick: false`, user can choose the
   folder), creates desktop/Start-menu shortcuts, and **does not delete app data on uninstall**.
3. The build is **unsigned** and has **no auto-update** (`publish: null`). SmartScreen warnings are
   expected until a code-signing certificate is provided; updates are manual installer runs.
4. Packaging is not part of `npm run verify` (it needs a build + electron-builder and takes minutes).
   Dedicated gates prove it:
   - `npm run pack:verify` — packaged executable `--selftest` + `--mgmttest`;
   - `npm run pack:verify:installer` — silent install → installed app self-tests → silent uninstall.
5. `release/` is git-ignored build output; installers are distributed as artifacts, not committed.
6. The archived Tauri tree supplies the app's own icons (`legacy/src-tauri/icons` → `build/`). No Mojang
   assets are packaged.

## Consequences

- Users get a normal Windows installer today; signing/auto-update can be added later without changing the
  app code.
- The packaged app uses the same hardened runtime path as the dev build (asar, sandbox, preload bridge,
  CSP, IPC validation) and its own `%APPDATA%\Block Server Manager\data` data root; the dev
  `.app-data` store is not reused.
- Package size is dominated by the Electron runtime (~116 MB installer).
