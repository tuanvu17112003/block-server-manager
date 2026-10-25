# WORKFLOW_STATE

## Current Goal
Materialize the approved Phase 5 CurseForge server-pack design, then implement it after the docs gate and dependency approval, preserving existing server creation and Modrinth behavior.

## Acceptance Criteria
- [x] Verify current import/install integration points and reuse boundaries.
- [x] Research official Tauri 2/WebView2 download handling, CurseForge server-pack UX/format, archive validation, and permitted dependency mechanisms.
- [x] Materialize source-backed research, specification, architecture decision(s), and implementation checklist in `docs/` before any production implementation.
- [x] Explicitly cover download progress/completion/cancellation/duplicates/redirects/failure; staged ZIP selection/refresh/browse; archive classification; safe extraction; loader/version/dependency detection; persistence/start reuse; ZIP retention.
- [x] Preserve existing Vanilla, Paper, Fabric, Forge, NeoForge, Quilt, and Modrinth workflows in the approved design.
- [x] Obtain independent review of the design documents and record the review outcome.
- [x] After docs review passes and dependencies are explicitly approved, implement the browser/download/staging/import path and reuse existing persistence/Start behavior.
- [x] Run the authorized feature/regression tests and static checks; report the platform-specific runtime verification limit accurately.

## Status
Phase: Done
Last updated: 2026-10-10
Owner: PQM
Active Task ID: none

## Active Plan
None. Completed and archived at `.workflow/archive/2026-10-10_curseforge-server-pack-import.md`.

## Recent Handoffs
### 2026-10-10 Reviewer → PQM
Task: `cf-phase5-design` code re-review | Result: PASS after two scoped implementation rework rounds | Files: CurseForge import implementation
### 2026-10-10 PQM → Focused Frontend Fixer
Task: `cf-phase5-design` | Result: request-identity fix; frontend build PASS | Files: `src/tabs/Create.tsx`
### 2026-10-10 Reviewer → PQM
Task: `cf-phase5-design` code re-review | Result: FAIL on stale inspection result | Files: `src/tabs/Create.tsx`
### 2026-10-10 PQM → Explorer / Scout
Task: `cf-phase5-design` code map | Result: complete | Files: read-only source/docs review
### 2026-10-10 PQM → Explorer / Scout
Task: `cf-phase5-design` official research | Result: complete | Files: read-only external research
### 2026-10-10 PQM → Reviewer / Critic
Task: `cf-phase5-design` docs review | Result: PASS after 2 scoped rework rounds | Files: CurseForge research/spec/ADR/implementation docs

## Decisions & Constraints
- The existing Phase 5 implementation is Modrinth-only. CurseForge API access/key-entry remains disabled pending the user's explicitly confirmed API approval and acceptable terms; this task designs a website + local ZIP path without enabling API access.
- Preserve existing Vanilla, Paper, Fabric, Forge, NeoForge, Quilt, Modrinth, EULA, installer cancellation, validation, and publication behavior.
- Use app-managed staging for downloaded/imported archives; preserve ZIPs by default and delete only after successful installation when an explicit setting is enabled.
- Avoid new Rust dependencies without explicit user consent. Reuse the already-approved ZIP support where technically suitable.
- User explicitly chose “Implement after docs”; do not begin production implementation before docs review passes.
- User approved aligning the declared Rust version to 1.90, retaining Tauri 2.12.1, and adding `tauri-plugin-dialog = 2.8.1`, `tauri-plugin-opener = 2.7.0`, and Windows-only `webview2-com = 0.39.1`. Cargo resolved them and updated the lockfile.
- User approved adding the additional Windows-only `windows-core = "=0.62.2"` dependency required by the WebView2 download observer.
- User approved adding and running feature and regression tests.
- Do not send commands to a live server or alter its process, logs, or database.

## Active Owned Paths
- `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/src/lib.rs`
- `src-tauri/src/modpacks/**`, `src-tauri/src/installer/mod.rs`, `src-tauri/src/servers/mod.rs`, `src-tauri/src/servers/process.rs` only if needed, `src-tauri/src/util/paths.rs`
- `src/tabs/Create.tsx`, `src/tabs/Settings.tsx`, `src/tauri.ts`, and focused store/types changes
- `src-tauri/capabilities/**`, `src-tauri/tauri.conf.json` only if needed
- Feature tests and linked docs

## Completed Implementation Summary

- Code paths changed: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/src/lib.rs`, `src-tauri/src/modpacks/mod.rs`, `src-tauri/src/modpacks/install.rs`, `src-tauri/src/modpacks/curseforge_import.rs`, `src-tauri/src/servers/process.rs`, `src-tauri/src/installer/mod.rs`, `src/tauri.ts`, `src/tabs/Settings.tsx`, and `src/tabs/Create.tsx`.
- Docs changed: `docs/research/2026-10-10-curseforge-server-pack-import.md`, follow-up `docs/research/2026-10-10-curseforge-webview2-bridge-follow-up.md`, `docs/specs/curseforge-server-pack-import.md`, `docs/architecture/adr/0012-curseforge-server-pack-import.md`, `docs/implementation/curseforge-server-pack-import.md`, the Phase 5 Modrinth spec cross-link, docs indexes/source list, and this state. The spec acceptance criteria and ADR/implementation status were updated after code review.
- Dependency/MSRV: declared Rust 1.90; retained Tauri 2.12.1; added approved Dialog 2.8.1, Opener 2.7.0, and Windows `webview2-com` 0.39.1 plus `windows-core` 0.62.2.
- Verification: `cargo check --offline --manifest-path src-tauri/Cargo.toml` PASS with two pre-existing dead-code warnings; `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib` PASS (73 tests); focused CurseForge tests PASS (9 tests); `npm run build` PASS (TypeScript + Vite, 49 modules); Rust formatting check PASS.
- Remaining runtime limitation: no live CurseForge/WebView2 download interaction was exercised. Non-Windows platforms use external browser + browse-to-stage. The initial new-import allowlist is fixture-validated Forge/NeoForge only; Vanilla/Paper/Fabric and Quilt imports remain unsupported. CurseForge API/key and client-export file resolution remain gated.
- Independent code review PASS after two narrow implementation rework rounds. Repository files were untracked, so no tracked-base diff was available for comparison.

## Quality Gate Results
- Reviewer: design docs PASS; independent code review PASS after scoped rework
- Rust: `cargo check --offline --manifest-path src-tauri/Cargo.toml` PASS; two pre-existing dead-code warnings remain.
- Feature tests: `cargo test --offline --manifest-path src-tauri/Cargo.toml modpacks::curseforge_import::tests` PASS, 9/9.
- Regression tests: `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib` PASS, 73/73.
- Frontend: `npm run build` PASS (`tsc` and Vite production build, 49 modules), including after UI race fix.
- Formatting: `rustfmt --edition 2021 --check` on the five changed Rust source files PASS.
- Frontend tests: no test runner is configured in the package scripts; stale-inspection protection uses request identity checks, selection invalidation, and an exact-name Configure/Install gate.
- Runtime limitation: embedded CurseForge browsing and WebView2 download callbacks were not exercised against a live site; non-Windows opens externally and uses the browse-to-stage path.
- Rework attempts: 2/3 design-document rounds; 2/3 implementation code-review rework (focused alternate worker for repeated UI-race class); task archived on completion.
