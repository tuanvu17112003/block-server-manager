# ADR-0020 — Electron is the sole shipped desktop runtime

- Status: Accepted (2026-10-26)
- Supersedes: ADR-0002 (Tauri desktop stack) for the shipped product; ADR-0019 (framework-neutral HTTP
  backend contract) remains valid as an optional browser deployment target.
- Context: the app was ported from Tauri 2 + Rust to Electron + TypeScript + React per
  `docs/electron-completion-plan.md`. The port is complete through Phase 6 and verified by the gates in
  `docs/verification.md`. The Rust tree is archived under `legacy/src-tauri/` as a frozen behavioural reference and is
  **not** part of any build, package, or runtime path.

## Decision

1. Electron (main process `electron/`, renderer `src/`) is the only desktop runtime shipped.
2. `legacy/src-tauri/` is archived reference code: no npm script, CI step, packaging step, or runtime
   import may depend on it. It was archived on 2026-10-28 after the Phase-8 verification sign-off and
   may be deleted once no longer useful as a reference.
3. The renderer supports exactly two real backend transports:
   - Electron IPC via the preload bridge (`window.electronAPI`), the desktop default;
   - the framework-neutral HTTP/SSE contract (ADR-0019) when `backend-config.json` is configured.
4. Browser mock data is a **dev-only explicit opt-in** (`VITE_MOCK_BACKEND=1 npm run dev:web`). It is
   never used implicitly: an Electron window without the preload bridge, and a browser build without a
   configured backend, fail closed with a diagnostic screen instead of fabricating data.
5. The CurseForge API key is user-supplied at runtime (Settings, encrypted with Electron `safeStorage`
   when available, file fallback `<dataRoot>/curseforge-key.txt`). It is never bundled, logged, or
   printed in diagnostics; keyless routes keep working without it.
6. No Mojang assets, fonts, or textures are bundled (`docs/specs/minecraft-style.md` IP red lines).

## Consequences

- One runtime to test and package; the `isTauri()`/`@tauri-apps/api` code paths were removed from the
  renderer adapter, and the stale `frontend-export/` artifact was retired.
- Tauri-only behaviours must be reimplemented in Electron when needed; the Rust tree remains the
  behavioural reference for parity questions (see `docs/audit/05-parity-matrix.md`).
- The HTTP transport keeps the frontend deployable in a browser against a compatible backend without
  Electron.
