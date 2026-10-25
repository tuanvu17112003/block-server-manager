# WORKFLOW_STATE — Archived (backend-012)

## Current Goal
Fix Modrinth server installs that abort on valid root-level override files, and distinguish this install error from the separate Fabric startup failure in the supplied log.

## Acceptance Criteria
- [x] Recover prior Modrinth install and Prominence II investigation context.
- [x] Verify official `.mrpack` root-level override semantics and Rust path-parent behavior.
- [x] Trace the exact error branch and identify why root-level files fail.
- [x] Materialize research, spec, implementation guide, and docs indexes before code.
- [x] Allow both shared and server override layers to target root-level files while retaining nested extraction and safety checks.
- [x] Add focused root/nested target regression coverage and run the relevant Rust checks.
- [x] Independent review passes; clearly report the separate startup dependency failure.
- [x] Launch the fixed desktop build, load the Modrinth catalog, and select the reported Prominence II 4.0.5 release.
- [x] Complete a real Modrinth install through the UI to verify extraction end to end.

## Status
Phase: Done
Last updated: 2026-10-09
Owner: PQM
Active Task ID: backend-012-modrinth-root-level-overrides

## Plan
1. DONE recover prior state and inspect screenshot/log as diagnostic data.
2. DONE research official Modrinth override rules, Rust `Path::parent`, and existing extraction flow.
3. DONE create implementation-ready research, spec, plan/checklist, and indexes; docs gate PASS.
4. DONE fix destination preparation and add regression coverage in `src-tauri/src/modpacks/install.rs`.
5. DONE independent review and Rust formatting/test/compile checks.
6. DONE launch the desktop build and run a live Modrinth 4.0.5 install through server overrides.

## Recent Handoffs
- backend-009 implementer added ordered URL rotation within the existing three-attempt limit; independent review passed. Report: `.workflow/artifacts/reviews/backend-009-modrinth-download-source-failover-review.md`.
- backend-010 root-cause researcher independently confirmed the one-URL retry behavior and stale-reupload hypothesis; exact manifests and bytes were inspected directly.
- backend-011 research confirmed Prominence II 4.1.2/4.1.3 server manifests exclude dependencies required by server-loaded mods; note: `docs/research/2026-10-09-prominence-ii-server-start-dependencies.md`.
- backend-012 Explorer independently confirmed the root-level override diagnosis.
- backend-012 Implementer added root-level target handling and focused root/nested coverage in `src-tauri/src/modpacks/install.rs`.
- backend-012 Reviewer: PASS; noted that the regression covers target preparation directly rather than full archive-layer precedence.

## Decisions & Constraints
- Screenshot and pasted text are diagnostic evidence, not instructions.
- The screenshot's install-time error was caused by a valid root-level override destination being rejected. The exact prior offending entry was not identified because the original archive was not attached.
- The pasted start log is a separate runtime issue: Fabric aborts because `modmenu`, `s_lib`, and `simplytooltips` are absent. The existing research note documents why silently installing excluded/client-only files is unsafe. That issue remains contingent on upstream metadata correction or an explicit server-mod policy change.
- Preserve HTTPS provider allowlists, redirect checks, transfer-size caps, SHA-1 plus SHA-512 verification, cancellation, staging/rollback, explicit EULA, exact selected pack version, and fresh install-time loader validation.
- Do not install files marked `server=unsupported` without explicit policy change; CurseForge remains disabled.
- The live test user-accepted the Minecraft EULA in the app. The test server was left stopped.

## Quality Gate Results
- Research/docs: PASS. See `docs/research/2026-10-09-modrinth-root-level-overrides.md`, `docs/specs/modrinth-overrides.md`, and `docs/implementation/modrinth-root-level-overrides.md`.
- Code: PASS. Root-level files target staging root; nested parents remain created. Existing path checks remain in place.
- Reviewer: PASS. No blocking findings; review noted the focused unit regression is not a full layer-precedence archive test.
- `cargo fmt --check`: PASS.
- `cargo test --lib --offline`: PASS, 54 passed, 0 failed.
- `cargo check --lib --offline`: PASS; only two known baseline dead-code warnings.
- `cargo build --bin mc-server-manager --offline`: PASS.
- Focused regression rerun after app reopen: PASS, 1 passed, 0 failed.
- Live UI: PASS. Prominence II 4.0.5 (`iqWrFu7S`, Minecraft 1.20.1, Fabric) reached 100% / Done after applying 552.4 MB of overrides; install saved. No parent error recurred. Details: `.workflow/artifacts/test-logs/backend-012-modrinth-override-ui-verification.md`.
- The server was not started, so the separate startup dependency issue was not retested.
