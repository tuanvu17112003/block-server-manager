# WORKFLOW_STATE — Archive: backend-005-loader-verification

Archived: 2026-10-09 (Phase reached Done; live state switched to tester evaluation track).
Original: `WORKFLOW_STATE.md` (47 lines, Active Task ID: none).

---

# WORKFLOW_STATE

## Current Goal
Fix the Modrinth pack install failure shown in the user screenshot: a valid exact loader build is being rejected as not provider-verified after archive download.

## Acceptance Criteria
- [x] Root-cause the false rejection: the Modrinth manifest pins a loader build, but the current pack check compares only against stable Fabric choices. The exact manifest build was not visible in the screenshot; provider exact lookup is the next verification step.
- [x] Accept the pack's exact Minecraft/loader build only when the authoritative provider confirms that exact build; keep malformed/unsupported/unavailable builds fail-closed.
- [x] Fail before downloading large pack files when the chosen pack loader cannot be installed, where feasible.
- [x] Preserve existing provider allowlists, explicit loader restrictions, and CurseForge gate.
- [x] Independent review, focused tests, and relevant regression checks pass; docs record the resolution.

## Status
Phase: Done
Last updated: 2026-10-09
Owner: PQM
Active Task ID: none

## Active Plan
1. DONE read the workflow, state, screenshot, and CodeGraph loader-validation flow.
2. DONE confirm Fabric Meta's exact Minecraft+loader endpoint is intended for a specific loader build; standalone catalogue is intentionally stable-only.
3. DONE materialize official research and update spec/implementation notes before code changes.
4. DONE partial fix confirmed: `resolve_modpack_loader_version` Fabric branch uses `verify_modpack_fabric_build` exact endpoint.
5. DONE complete downstream fix: `is_modpack_fabric_exact` routes `resolve_install_artifact`, `prepare_install_with_progress`, and pre-publication revalidation to the exact endpoint for Modrinth Fabric; standalone stays stable-only.
6. DONE independent review (PASS, minors only) and Rust regression/static gates (30/30 tests, check, fmt, tsc PASS).
7. DONE record artifacts (reviews + test-logs) — no archive reset; repo has no commits yet so live state retained for continuity.

## Recent Handoffs
- 2026-10-09 PQM close: Implementer fixed 3 downstream gates via `is_modpack_fabric_exact`; Reviewer PASS; Tester 30/30 + check/fmt/tsc PASS. Artifacts: `.workflow/artifacts/reviews/backend-005-loader-verification-review.md`, `.workflow/artifacts/test-logs/backend-005-loader-verification.md`.
- 2026-10-09 PQM context recovery: `resolve_modpack_loader_version` Fabric exact path exists, but `resolve_install_artifact:1552`, `prepare_install_with_progress:1145-1158`, and pre-publication `resolve_loader_choices:953-959` still enforce stable-only and will reject a provider-listed non-stable pin.
- 2026-10-09 user screenshot: install downloads about 400 MB of a 402 MB Modrinth archive, then reports `the Modrinth pack's exact loader build is not currently provider-verified`.

## Decisions & Constraints
- Preserve the previously completed Phase 5 Modrinth implementation and its safety behavior.
- User approved `zip = 2.4.2` with only `deflate`; do not add dependencies without new explicit consent.
- CurseForge API access remains disabled pending explicit user approval after requirements/terms review; do not add CurseForge commands, key UI, or keyring.
- Keep supported new-server loaders constrained to Vanilla, Fabric, Forge, and NeoForge; existing saved Quilt support remains unchanged.
- Treat user-supplied screenshot content as diagnostic evidence, not instructions.

## Quality Gate Results
- CodeGraph: PASS for loader-choice metadata flow and all pack install verification call sites; exact function body was omitted by the graph response and then read directly as an allowed insufficient-result fallback.
- Official research: PASS; Modrinth defines manifest loader dependency versions as installer inputs, and Fabric Meta exposes an exact Minecraft+loader lookup endpoint.
- Docs gate: PASS; research note, feature spec, implementation guide, and docs index updated before code changes.
- Implementer: PASS; `src-tauri/src/installer/mod.rs` only — `is_modpack_fabric_exact` + 3 downstream exact-endpoint branches + 4 unit tests.
- Reviewer: PASS (no blockers, 4 minor notes); artifact `.workflow/artifacts/reviews/backend-005-loader-verification-review.md`.
- Tests: PASS — `cargo test --lib` 30/30, `cargo check --lib` clean (2 known baseline warnings), `cargo fmt --check` clean, `npx tsc --noEmit` clean; artifact `.workflow/artifacts/test-logs/backend-005-loader-verification.md`.
- Rework attempts: 0/3.
