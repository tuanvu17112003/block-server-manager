# WORKFLOW_STATE

## Current Goal
Remove Quilt from new server installation and resolve New Server navigation, flow state, responsive layout, and complete official Minecraft release discovery.

## Acceptance Criteria
- [x] Quilt cannot be selected or installed for new servers; existing saved Quilt servers retain management/start behavior.
- [x] Every New Server entry starts with a fresh server type selection, and choosing a type updates the Configure state.
- [x] Selecting a saved server in the sidebar exits New Server and opens that server without requiring Back; ordinary sidebar selection preserves the active tab outside Create.
- [x] Overview and New Server content fit and remain usable at compact and wide window sizes without clipping or overlap.
- [x] Vanilla discovery includes all official Mojang release entries; Paper and other loaders expose only provider-supported compatible releases.
- [x] Java requirements for currently available releases are supported, including Java 25 for Minecraft 26.1; EULA and process safety remain intact.
- [x] Research, specs, implementation docs, and current state agree with the change.

## Status
Phase: Done
Last updated: 2026-10-09
Owner: PQM
Active Task ID: ui-005

## Active Plan
1. DONE recover the Phase 4 context, active constraints, and Create/server call paths with CodeGraph.
2. DONE research Mojang release metadata, React state reset behavior, responsive layout guidance, and current Java 25 requirement.
3. DONE materialize research, architecture decision, feature spec, and implementation checklist before code.
4. DONE finish responsive behavior in the Overview dashboard after the user's screenshot showed its Status action row still overlaps the Players card.
5. DONE independent review PASS for original changes and responsive follow-up; TypeScript check passes.
6. DONE complete Test phase: TypeScript and shimmed frontend build pass; Rust tests pass 9/9; Rust check passes; user confirms the app works as designed. Results: `.workflow/artifacts/test-logs/ui-005-verification.md`.
7. DONE clear the formatter finding with a formatting-only change, then pass independent review, `cargo fmt --check`, `cargo test --lib`, and `cargo check --lib`.
8. DONE archive completed task state here and reset the live dashboard. Earlier snapshots: `.workflow/archive/2026-10-09_ui-005_pre-test.md` and `.workflow/archive/2026-10-09_ui-005_post-test.md`.

## Recent Handoffs (last 3–5 only)
- 2026-10-09 PQM → Independent Reviewer review_new_server — PASS after two scoped P2 fixes: first-run session reuse and stale loader choice display.
- 2026-10-09 PQM → Independent Reviewer responsive_followup — PASS; Overview grids collapse by content width and Status/Server action rows wrap.
- 2026-10-09 PQM → Implementer ui_005_format_fix — DONE; only two rustfmt changes in `src-tauri/src/installer/mod.rs`; crate format check passes.
- 2026-10-09 PQM → Independent Reviewer ui_005_format_review — PASS; no behavior/API issue found; full before/after diff unavailable because checkout files are untracked.
- 2026-10-09 PQM → Tester ui_005_final_test — PASS; Rust formatting, tests (9/9), and check all pass offline.

## Decisions & Constraints (current only)
- Windows-first Tauri 2 + React/Vite; preserve browser mocks and EULA/process safety.
- Offer all Mojang entries with `type == release`; snapshots, pre-releases, alpha, and beta remain excluded, consistent with the existing picker.
- Provider-specific choices remain limited to exact compatible metadata; Paper stays STABLE-only.
- Remove Quilt from new loader choices, resolution, and install dispatch. Preserve process support for already-saved Quilt servers.
- Support the currently available Minecraft release Java requirements with Temurin 8/17/21/25; Mojang version metadata remains authoritative when available.
- Existing modpack browse filters are separate from the standalone server loader choice; no pack-install feature expansion.
- Do not add Rust dependencies or alter EULA, server publication, or process-management safety behavior.
- Research/spec/implementation docs are required before implementation; see `docs/research/2026-10-09-new-server-improvements.md`, `docs/specs/server-installs.md`, `docs/specs/java-provisioning.md`, and `docs/implementation/new-server-improvements.md`.

## Quality Gate Results (current task)
- Research: PASS; primary sources are linked in the new research note.
- Docs gate: PASS; feature docs and the rustfmt follow-up note are indexed in the docs tree.
- Reviewer: PASS for requested behavior and responsive follow-up; formatter follow-up also PASS with the checkout diff limitation documented.
- Responsive follow-up review: PASS for compact/wide Overview grids and wrapping action rows.
- Native app smoke: PASS by user confirmation; user reports the app works as designed.
- TypeScript: `npx tsc --noEmit` PASS.
- Production build: PASS with the documented temporary external Node realpath fallback; raw host invocation still hits `EPERM` on `src/main.tsx`.
- Rust: `cargo test --lib` PASS, 9/9; `cargo check --lib` PASS; `cargo fmt --check` PASS after the formatting-only correction. Two existing dead-code warnings remain.
- Test scripts: no npm `test` script is configured. Full results: `.workflow/artifacts/test-logs/ui-005-verification.md`.
- Rework attempts: 1/3; formatter-only correction passed review and rechecks.
