# WORKFLOW_STATE

## Current Goal
Complete backend Phase 4 server software discovery and installation for the currently supported Minecraft catalogue.

## Acceptance Criteria
- [x] Vanilla/Paper/Fabric server install flows are wired through Tauri Create for supported Minecraft versions; all six planned providers resolve compatible choices.
- [x] Cancel and failure clean up staged output; progress/logs are visible; persistence occurs only after validation.
- [x] Every published loader has a validated launch shape; unavailable selections cannot submit another loader; orphan recovery checks saved launch identity.
- [x] EULA is never auto-accepted; existing Java 8/17/21 scope, process safety, browser mocks, and Create completion flow remain intact.
- [x] Phase 4 specs, research, ADR, implementation plan, and checklist were materialized before code changes.
- [x] Independent review and available verification gates completed; unavailable host/live-provider checks are documented in `.workflow/artifacts/test-logs/backend-004-verification.md`.

## Status
Phase: Done
Last updated: 2026-10-08
Owner: PQM
Active Task ID: none

## Active Plan
1. DONE recover Phase 3 archive, Phase 4 roadmap, current architecture, and Create/process/Java extension points with CodeGraph.
2. DONE gather official provider/installer research and confirm versioning, stability, launch modes, and cancellation constraints.
3. DONE materialize the Phase 4 docs tree before implementation.
4. DONE implement six-provider discovery/install IPC, staging/cancellation, loader-specific start, typed Create progress/error states, and provider-aware orphan identity.
5. DONE complete three bounded, scoped review rework attempts; final independent review PASS.
6. DONE run TypeScript and production build with the host workaround; 10 Rust unit tests passed with a temporary test-only Tauri entrypoint gate; record native and live-provider limits.
7. DONE archive this completed Phase 4 task and reset live state.

## Recent Handoffs (last 3–5 only)
- 2026-10-08 PQM → Explorer backend-004-research — DONE: official provider sources and installer workflows collected; no project edits.
- 2026-10-08 PQM → Implementer backend-004-impl — DONE: six-provider metadata/install flow and Create integration; TypeScript and diff checks pass; host build limitations recorded.
- 2026-10-08 PQM → Reviewer backend-004-review — FAIL: one P1 process launch gap and two P2 loader-choice/output-validation issues.
- 2026-10-08 PQM → Implementer backend-004-R1 — DONE: all three findings fixed; loader-aware launcher uses direct tracked Java.
- 2026-10-08 PQM → Reviewer backend-004-rereview-r1 — FAIL: original findings fixed; P2 stale-lock identity matcher still required `server.jar` for non-JAR loader launches.
- 2026-10-08 PQM → Reviewer backend-004-rereview-r1 — additional P2: Quilt nested payload parent needs symlink/junction/reparse-point rejection.
- 2026-10-08 PQM → Reviewer backend-004-rereview-r1 — FAIL after R2: Start's second launch-mode resolution still checks only the nested JAR leaf; add the same parent-path guard.
- 2026-10-08 PQM → Implementer backend-004-R3 — DONE: shared Start resolver rejects Quilt parent symlinks/reparse points; resolver-level regression test added.
- 2026-10-08 PQM → Reviewer backend-004-final-review-r3 — PASS: no confirmed defects.
- 2026-10-08 PQM → Tester backend-004-final — PASS with limitations documented: 10 Rust tests, TypeScript, and shimmed Vite build pass; raw host build commands blocked by path/OUT_DIR issues.

## Decisions & Constraints (current only)
- Windows-first desktop app using Tauri 2 + React/Vite; preserve browser mocks.
- Minecraft EULA is never auto-accepted; RCON binds only to `127.0.0.1`; no secrets or Mojang assets are bundled.
- Phase 3 runtime scope is Windows x64 Temurin 8/17/21. Minecraft 26.1 requires Java 25 and remains unsupported until explicitly planned.
- Phase 4 intersects live provider metadata with the existing seven-version catalogue; Paper exposes STABLE builds only; Forge labels recommended/latest distinctly; new Rust dependencies are out of scope.
- Install into an isolated staging directory and persist the server only after successful artifact validation; cancellation terminates the installer and removes staging output.
- Create's EULA checkbox is the only action allowed to write `eula=true`; a missing/unchecked acceptance always leaves `eula=false`.
- Modpack installation remains Phase 5; the Tauri path must not claim mocked modpack installs succeeded.
- Use CodeGraph first for structural code work when indexed; research before implementation and materialize docs before coding.
- Keep `.gitignore` build output exclusions and the user-approved vendored `.opencode/skills/` tree.

## Quality Gate Results (current task)
- Research: DONE; see `docs/research/2026-10-08-phase4-server-installs.md`.
- Docs gate: PASS; see `docs/specs/server-installs.md`, `docs/implementation/phase4-server-installs.md`, and ADR-0004.
- Reviewer: PASS after rework attempt 3/3.
- Tests/build: `npx tsc --noEmit` PASS; `npm run build` PASS with temporary external realpath fallback (raw host invocation EPERM); 10 Rust tests PASS with temporary test-only Tauri entrypoint gate; ordinary Cargo test blocked by Tauri `OUT_DIR`; cargo fmt path canonicalization denied. No live provider installers/launches.
- Rework attempts: 3/3 complete.

## Post-archive verification update (2026-10-08)

- Rust `cargo test --lib` passes 10/10, `cargo check`, `cargo fmt --check`, and the Tauri binary build pass with elevated access to the installed toolchain/registry. Rust formatting was applied to the three Phase 4 files.
- A disposable-profile Tauri launch reached backend startup but exited before a window appeared. The `APPDATA` override was ignored; read-only inspection found zero server rows in the normal app database. The normal app-data directory was left intact, and the disposable test profile was removed.
- Phase 4 remains in `Phase: Test` in the live `WORKFLOW_STATE.md` until a live Tauri Create install/start smoke is completed or the user waives that gate.
- Current verification artifact: `.workflow/artifacts/test-logs/backend-004-verification.md`.

## Tauri window investigation update (2026-10-08)

- A regular launch with only APPDATA/LOCALAPPDATA overrides did not isolate app data and exited before a window appeared. Read-only DB check found zero server rows; the normal app-data directory was left intact.
- A test-only build with Tauri's documented `appDirectoriesOverride` and a test identifier opens a responsive `Block Server Manager` window with isolated data under the Codex visualization workspace. Native CUA control is unavailable in this session, so the live Create/install path remains pending. No provider downloads or EULA acceptance were performed.

## Tauri startup root-cause narrowing (2026-10-08)

- A build with the production identifier and only Tauri's official `appDirectoriesOverride` opened a responsive `Block Server Manager` window. This, compared with the normal app-data launch, narrows the startup failure to the default app/WebView data path, but the exact failure is not confirmed. See https://v2.tauri.app/reference/config/#appdirectoriesoverride.
- The native CUA surface cannot control the Tauri window in this session. The isolated same-identifier test window remains open under the Codex visualization root for manual interaction. No provider install or EULA acceptance was performed.

## Same-identifier startup A/B (2026-10-08)

- Rebuilt with the production identifier and only `appDirectoriesOverride` set to a dedicated C: test path; the window title was `Block Server Manager`, the process was responsive, and the backend logged ready. This narrows the normal-profile startup issue to the default app/WebView data path, but does not identify the underlying permission/profile error. Tauri config reference: https://v2.tauri.app/reference/config/#appdirectoriesoverride.
- Native CUA control is unavailable. The process was no longer present at a later check, with no close-event log; no live Create UI actions were performed.
