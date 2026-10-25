# Backend Phase 4 — Verification

Date: 2026-10-08  
Task: `backend-004`  
Independent review: PASS after three scoped rework attempts.

## Frontend

| Command/check | Result |
|---|---|
| `npx tsc --noEmit` | PASS (exit 0) |
| `npm run build` | Host failure (exit 1): Vite/Node native `realpath` returned `EPERM` for `src/main.tsx` on H:. |
| `npm run build` with temporary external Node `realpathSync.native` fallback | PASS (exit 0; 48 modules transformed). The shim was written under the OS temp directory and removed in `finally`; no app source/config changed for the workaround. |
| Whitespace scan of changed source/docs | PASS; no trailing whitespace matches. |

## Rust

| Command/check | Result |
|---|---|
| `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib` | Blocked before tests: `tauri::generate_context!()` reports `OUT_DIR` unavailable. |
| `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib` with elevated access to the installed toolchain/registry | PASS: 10 passed, 0 failed (5 Java tests and 5 Phase 4 launch identity / Quilt path tests). |
| `cargo check --offline --manifest-path src-tauri/Cargo.toml` with elevated access | PASS. |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml` with elevated access | PASS after `rustfmt --edition 2021` formatted the three Phase 4 Rust files. |
| `cargo build --offline --manifest-path src-tauri/Cargo.toml --bin mc-server-manager` with elevated access | PASS. |

## Review and coverage limits

- Independent reviewer: PASS; no confirmed defects remain. Review covered provider-specific launch selection, cancellation/publication, stale-lock identity, UI loader mismatch, EULA behavior, and Quilt reparse-point handling.
- Browser-mode Create smoke: PASS. Opened the existing local app, selected Vanilla, ran mock progress to 100%, created the mock server, and confirmed the completion state says the EULA remains unaccepted and Start stays blocked. No EULA checkbox was accepted; the temporary browser tab was closed afterward.
- A normal Tauri launch with only `APPDATA`/`LOCALAPPDATA` environment overrides did not isolate app data and exited before a window appeared. Read-only inspection found zero server rows in the normal app DB; its DB/log directory was left intact.
- A same-identifier test build using only Tauri's official `appDirectoriesOverride` started a responsive `Block Server Manager` window and logged backend ready. This narrows the failure to the default app/WebView data path, though the exact cause is not confirmed. Tauri documents that this override also redirects the Windows WebView data directory: https://v2.tauri.app/reference/config/#appdirectoriesoverride.
- Native CUA app-window control is unavailable in this session, so the live Create/install UI could not be operated. The test process was no longer present at a later check; its log had no close event, so I cannot say whether it closed normally or exited later. Its isolated profile remains partially under the Codex visualization workspace because Windows held `app.db` open during cleanup; read-only inspection found no server rows. The normal app-data directory was left intact.
- No EULA was accepted and no provider install was started.
- The earlier normal app-data run opened the regular database/log; read-only inspection found zero server rows. That directory was left intact. A prior test profile may remain partially under the visualization root because Windows held its `app.db` open during cleanup.
- No live Vanilla/Paper/Fabric/Quilt/Forge/NeoForge download or server process launch was run. Provider network payload behavior and the full desktop Create happy path remain unverified live.
- No Rust dependencies were added.

## User screenshot follow-up (2026-10-08)

- The user-provided screenshots show the mock UI path: the type screen offers CurseForge and Modrinth modpacks, the configure screen labels Java detection and the port check as “mock,” and the install screen uses generic “downloading server jar + mods” copy. This does not establish whether the container is a browser tab or a native Tauri shell.
- The install screen remains on “INSTALL — DONE” with “Done — create server” still available. This demonstrates the mock wizard’s completion step, but not a Tauri provider download, persistent server creation, or server start. The live Tauri smoke gate remains open.
- The project’s custom runtime check tests `window.__TAURI__`, but `tauri.conf.json` does not enable `withGlobalTauri`; Tauri’s official `core.isTauri()` helper is the appropriate runtime check. The screenshots may therefore be from a native window that still rendered the mock branch.

## Tauri CLI setup follow-up (2026-10-08)

- Installed project-local `@tauri-apps/cli` 2.12.1; `npm exec -- tauri --version` passes.
- Sandboxed `npm exec -- tauri dev` fails Vite dependency scanning with H: drive `realpath` EPERM. Elevated retry starts Vite on port 1420, then Rust compilation fails because `src-tauri/icons/icon.ico` is missing.
- Starting the previously built `src-tauri/target/debug/mc-server-manager.exe` returned PID 26104, but that process exited shortly afterward. Native UI control is unavailable in this session.
- At that point no source or icon changes had been made; the user later approved both changes.

## Native launch follow-up (2026-10-09)

- Added `@tauri-apps/cli` 2.12.1 as a local npm dev dependency; `npm exec -- tauri --version` passes.
- Added a square SVG app icon and generated the Windows `icon.ico` plus standard platform variants with the Tauri CLI icon command.
- Updated `src/tauri.ts` to use the official `isTauri` helper from `@tauri-apps/api/core`, so browser mode retains mocks without requiring the opt-in `window.__TAURI__` global.
- `npx tsc --noEmit` passes. Sandboxed `tauri dev` still hits H: drive `realpath` EPERM; the elevated run succeeds: Vite listens on port 1420, Rust compilation finishes, and the `mc-server-manager` process is responsive.
- Native UI interaction is unavailable in this session. No provider-backed install, saved-server verification, or server start was performed; the live smoke gate remains open.

## Post-validation publication fix (2026-10-09)

- The user’s native Tauri Vanilla attempt downloaded and validated the server artifact, then failed at 94% with `io error: Access is denied. (os error 5)` before a server record appeared.
- A focused Rust probe on Windows reproduced OS error 5 when renaming a staging directory while its `installer.log` append handle remained open; the same move succeeded once the handle was dropped.
- `src-tauri/src/servers/mod.rs` now appends the publication log through a short-lived helper, so the handle closes before moving the staged directory. The rename error also includes operation context. A Windows-only regression test verifies that the staged JAR and appended log move successfully.
- `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib`: PASS, 11/11. `cargo fmt --check --manifest-path src-tauri/Cargo.toml`: PASS. Elevated `npm exec -- tauri dev` rebuilds successfully; the app process is responsive (PID 25820) and Vite listens on port 1420. Two existing dead-code warnings remain.
- Independent reviewer: PASS; no defects found. Native UI input remains unavailable in this session, so the live Vanilla retry and Paper/Fabric/start smoke remain pending.

## Quilt checksum resolution (2026-10-09)

- The user reported a native Quilt install failure: `server artifact SHA256 mismatch` while downloading an 8,734,533-byte installer; other server installs and Java provisioning work.
- Quilt Meta listed installer 0.15.1 SHA-256 `2bd88a1429eaeb3ce3f5e9c49c591c551012937b35bf332ca277b4d93d70408d`. A fresh official Maven download had the same size but SHA-256 `0a229138caa1b87fd8f5622038410696f98bb85871a279640e7002404c4d0dc2`, matching the Maven `.sha256` sidecar. Several older sidecars also differed from their Quilt Meta hashes.
- The user approved using the exact artifact’s Maven sidecar with a visible mismatch warning. Quilt downloads fetch the sidecar only from the validated Maven URL without following redirects, require HTTP 200, parse only a bare digest or digest plus exact filename, show the Meta/sidecar discrepancy in the install log, and fail closed for missing/malformed sidecars or downloaded-byte mismatch. Hash errors identify the artifact filename.
- Rust suite: PASS, 18/18, including metadata/sidecar comparisons, strict checksum syntax, non-Maven host rejection, no-redirect policy, and HTTP 200 enforcement. `cargo fmt --check`: PASS. Elevated `npm exec -- tauri dev` rebuilds successfully; the app is responsive (PID 15640) with Vite on port 1420. Two existing dead-code warnings remain.
- Independent review: PASS; no defects found. The live Quilt retry is pending; no successful Quilt server installation has been confirmed yet.
