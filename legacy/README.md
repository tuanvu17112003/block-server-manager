# Legacy — archived Tauri/Rust tree (frozen reference)

`src-tauri/` was the original Tauri 2 + Rust backend of Block Server Manager. The app was ported to
Electron + TypeScript + React and the Tauri tree was **archived here on 2026-10-28** after the Phase-8
verification sign-off (see [ADR-0020](../docs/architecture/adr/0020-electron-sole-runtime.md)).

- It is **not built, packaged, or imported** by any npm script, CI step, or the Electron app. The only
  runtime dependencies of this repository are `electron/`, `src/`, `shared/` and the build scripts.
- It is kept for behavioural parity questions (command semantics, SQLite schema used by the legacy
  importer, installer edge cases) and for the app icons copied into `build/` for NSIS packaging.
- Historical docs under `docs/audit/` and `docs/research/` refer to paths as `src-tauri/...`; those files
  now resolve under `legacy/src-tauri/...`.
- The tree may be deleted entirely once it is no longer useful as a reference; it has no build
  obligations.
