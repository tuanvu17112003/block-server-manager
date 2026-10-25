# WORKFLOW_STATE

## Current Goal
Complete backend Phase 4 server discovery and installation for the supported Minecraft catalogue, including resolution of the Quilt checksum disagreement and remaining Tauri Create smoke.

## Acceptance Criteria
- [x] Six-provider discovery/install IPC and Create wiring implemented within the seven-version/Java 8/17/21 boundary.
- [x] Staged cancellation, artifact validation, launch-mode validation, rollback, and explicit EULA behavior implemented.
- [x] Independent final code review PASS; browser mock Create smoke PASS.
- [x] Available TypeScript/build and focused Rust unit gates pass with documented host workarounds.
- [ ] Live Tauri Vanilla/Paper/Fabric install and start smoke on Windows, or the user's explicit waiver of that gate.

## Status
Phase: Test
Last updated: 2026-10-09
Owner: PQM
Active Task ID: backend-004

## Active Plan
1. DONE recover Phase 3 context and Phase 4 roadmap; map extension points with CodeGraph.
2. DONE official provider research and docs materialization before implementation.
3. DONE implement provider discovery, cancellable installs, Create wiring, launch modes, and orphan identity.
4. DONE three scoped review reworks; final independent Reviewer PASS.
5. DONE browser-mode Create smoke with EULA left unaccepted.
6. DONE TypeScript, production build with host workaround, 10 Rust unit tests, cargo check/fmt, and Tauri binary build.
7. DONE add the missing project-local Tauri CLI as an npm dev dependency; existing Tauri 2 Rust/API dependencies and Vite port configuration were already present. Research and setup docs: `docs/research/2026-10-08-tauri-cli-setup.md`, `docs/implementation/tauri-cli-setup.md`.
8. DONE generate `src-tauri/icons/icon.ico` and standard platform variants; replace the custom `window.__TAURI__` check with Tauri's official `core.isTauri()` helper.
9. DONE elevated `npm exec -- tauri dev`: Rust compilation succeeded and a responsive native process/Vite listener were confirmed. Native CUA cannot control the window in this session.
10. DONE user live Vanilla install reached provider artifact validation, then failed during publication with `Access is denied. (os error 5)`; no saved server appeared.
11. DONE fix the Windows publication failure by closing the append log before moving its containing staging directory; add a focused Windows regression test.
12. DONE Rust tests 11/11, `cargo fmt --check`, elevated Tauri development build, and independent review PASS.
13. IN PROGRESS updated Tauri app is running responsively (PID 25820; Vite on port 1420). Native CUA cannot operate the window in this session.
14. DONE user reports non-Quilt server install types and the Java package install feature work; Quilt fails SHA-256 validation.
15. DONE investigate Quilt 0.15.1 checksum mismatch: official Meta SHA-256 differs from the same-size Maven artifact and its SHA-256 sidecar. Maven sidecar matches artifact bytes, but it is not an independent trust source.
16. DONE user approved using the exact artifact's Maven `.sha256` sidecar with a visible warning when it disagrees with Quilt Meta; missing/malformed sidecars and artifact mismatches must fail closed.
17. DONE implement Quilt sidecar verification, visible mismatch warning, exact Maven host/filename checks, no redirects, HTTP 200 requirement, and strict checksum syntax. Rust tests 18/18 and formatter pass.
18. DONE elevated Tauri dev build and independent review PASS; no defects found.
19. IN PROGRESS updated native app is responsive (PID 15640; Vite on port 1420). Native CUA is unavailable in this session.
20. PENDING user retry of the live Quilt install and remaining start smoke; the user must explicitly accept the EULA before start.

## Recent Handoffs (last 3–5 only)
- 2026-10-08 PQM → Explorer backend-004-research — DONE; see `docs/research/2026-10-08-phase4-server-installs.md`.
- 2026-10-08 PQM → Implementer backend-004 — DONE after three scoped review reworks; see `.workflow/archive/2026-10-08_backend-phase4-server-installs.md`.
- 2026-10-08 PQM → Independent Reviewer — PASS after rework attempt 3/3.
- 2026-10-08 PQM → Tester — 10 Rust tests, cargo check/fmt, and Tauri binary build PASS with elevated access; a same-identifier appDirectoriesOverride build reaches a responsive window, but native UI control is unavailable.
- 2026-10-09 PQM → Independent Reviewer tauri-cli-setup — PASS; no defects found in local CLI setup, runtime detection, or icon assets.
- 2026-10-09 PQM → Explorer install_denied_scout — DONE; post-validation failure occurs in `publish_installed_server`; rename is the leading failing operation. Controlled Rust probe narrowed it to an open `installer.log` handle during the directory move.
- 2026-10-09 PQM → Independent Reviewer publication_fix_review — PASS; no defects found in handle lifetime, rollback, EULA behavior, or the regression test.
- 2026-10-09 PQM → Explorer quilt_hash_scout — DONE; high-confidence upstream metadata/artifact mismatch; Maven sidecar fallback has weaker independent trust, which the user explicitly accepted with a visible warning.
- 2026-10-09 PQM → Independent Reviewer quilt_checksum_review — PASS after redirect, HTTP status, and strict sidecar parser hardening; no defects found.

## Decisions & Constraints (current only)
- Windows-first Tauri 2 + React/Vite; preserve browser mocks.
- Minecraft EULA is never auto-accepted; RCON binds only to `127.0.0.1`; no secrets or Mojang assets are bundled.
- Phase 3 runtime scope remains Windows x64 Temurin 8/17/21; Minecraft 26.1/Java 25 remains unsupported until explicitly planned.
- Phase 4 provider results stay within the existing seven-version catalogue; Paper exposes STABLE builds; no Rust dependencies were added.
- Publish only validated staged installs. Process start and orphan recovery use the saved provider launch shape and per-server marker; Quilt nested paths reject symlink/junction/reparse parents.
- Modpack installation remains Phase 5; Tauri must not report mocked pack installs as successful.
- Use the project-local npm Tauri CLI; do not add a global Cargo CLI install for this task.
- The user approved adding the missing icon and correcting runtime detection for the native smoke test.
- Close publication log handles before moving their containing directory; preserve atomic rename, publish-after-validation, and failure cleanup behavior.
- Quilt installer integrity remains mandatory; the user approved exact-artifact Maven sidecar verification with a visible mismatch warning and fail-closed handling. The sidecar request must be restricted to the exact host, require HTTP 200, and parse strict checksum syntax.
- Research and acceptance docs: `docs/specs/server-installs.md`, `docs/implementation/phase4-server-installs.md`, ADR-0004.

## Quality Gate Results (current task)
- Research/docs: PASS.
- Reviewer: PASS, no confirmed defects.
- `npx tsc --noEmit`: PASS.
- `npm run build`: raw host invocation fails with Vite `realpath` EPERM; production build passes with a temporary external realpath fallback.
- Rust: `cargo test --lib` 10/10, `cargo check`, `cargo fmt --check`, and Tauri binary build PASS with elevated access to the installed toolchain/registry. Direct sandboxed Cargo run is blocked by H: canonicalization.
- Browser mock Create: PASS through Vanilla mock progress/completion; EULA left unchecked. Live Tauri provider download remains unverified because native CUA cannot interact. Start additionally requires the user to accept the EULA.
- Tauri CLI setup: `@tauri-apps/cli` 2.12.1 installed; version command passes. Elevated `tauri dev` compiles and starts the responsive native process; sandboxed Vite still fails the host `realpath` permission check.
- `npm exec -- tauri icon src-tauri/icons/app-icon.svg --output src-tauri/icons`: PASS; generated `icon.ico` plus standard platform icon variants.
- `npx tsc --noEmit`: PASS after runtime-detection change.
- User screenshots reviewed 2026-10-08: the earlier screen showed the mock UI path and did not establish whether the container was a browser or native shell.
- User screenshot reviewed 2026-10-09: native Tauri Vanilla flow reached real provider metadata/download and artifact validation, then failed before server persistence with Windows access denied.
- Post-validation publication fix: focused Windows regression passed; Rust suite 11/11, `cargo fmt --check`, elevated Tauri dev build, and independent review PASS. Updated native app is currently responsive; live retry/start remains pending.
- User reports all non-Quilt server install types and Java provisioning work. Quilt 0.15.1 fails SHA-256 verification; a fresh official artifact download matches its Maven `.sha256` sidecar (`0a229...`) but not the current Quilt Meta hash (`2bd88...`). The user approved using the sidecar with a visible warning. Rust suite 18/18, formatter, Tauri build, and independent review pass; live retry remains pending.
- Artifact report: `.workflow/artifacts/test-logs/backend-004-verification.md`.
