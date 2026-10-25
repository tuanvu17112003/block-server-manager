# WORKFLOW_STATE

## Current Goal
Rebuild the modpack server setup pipeline in the current app using the reviewed open-source/free implementation patterns, with CurseForge keyless and new Quilt installs deferred.

## Acceptance Criteria
- [x] Review the supplied alternatives survey and verify key claims against upstream project pages.
- [x] Review the full handoff research, architecture, specification, implementation plan, and alternatives comparison.
- [x] Map the current modpack setup flows with CodeGraph and compare them with current support decisions.
- [x] Materialize research review, ADR, overhaul spec, and phased implementation plan before code changes.
- [x] Independent review the overhaul docs and close findings on ownership, diagnostics, integrity, redirects, and regression cases.
- [x] Update the Create-wizard validation message to include the validated ServerPackCreator Fabric exception without implying general Fabric support.
- [x] Keep CurseForge keyless and require author-provided server ZIPs.
- [x] Keep Quilt as a planned/disabled placeholder for new installs.
- [x] Make the completed-but-invalid CurseForge download error actionable without weakening ZIP validation; independent review PASS.
- [x] Add the phase-1 shared models for exact provider pins, local/remote archive verification, file decisions, install stages, reports, managed files, and launch config.
- [x] Phase-1 code review PASS conditional on active-plan rederivation and DB/root/hash/protected-path consumer gates.
- [x] Implement content-based CurseForge classification and local `.mrpack` manifest inspection in the new pipeline, with generated fixtures and the documented narrow format support; phase-2 independent review PASS after scoped rework.
- [x] Implement provider resolution and file-policy core; independent phase-3 review PASS after final scoped snapshot rework.
- [x] Implement and independently review exact Vanilla/Fabric/Forge/NeoForge loader preparation and completeness checks.
- [x] Implement and independently review verified downloads, transactional publication, managed-file ownership, rollback, and reports; final review PASS after the user-authorized cancellation fix.
- [x] Implement and independently review launch configuration and startup readiness/diagnostics; the final review and focused proof passed after scoped rework.
- [x] Migrate the Create UI after the new pipeline passed review and regression gates; Phase-7 bridge smoke and independent source review PASS.

## Status
Phase: Complete
Last updated: 2026-10-13
Owner: PQM
Completed Task ID: modpack-server-setup-overhaul

## Active Plan
1. [x] Review the report and choose an in-app pipeline using compatible patterns, not a third-party runtime.
2. [x] Lock user boundaries: CurseForge server ZIP only; no API/key flow; Quilt stays a placeholder.
3. [x] Map current entry points and downstream effects with CodeGraph.
4. [x] Write the rebuild ADR, spec, and phased checklist before implementation.
5. [x] Independent plan review PASS after scoped documentation rework.
6. [x] Phase 1 shared models and schema are in place; independent code review PASS with specified consumer gates.
7. [x] Phase 2: content-based CurseForge classification and Modrinth local archive metadata inspection; review PASS after scoped rework.
8. [x] Phase 3: provider resolution and file policy; independent review PASS after scoped rework attempt 3/3.
9. [x] Phase 4: prepare exact supported loaders and prove staged runtime completeness; rework attempt 1/3 passed independent review.
10. [x] Phase 5 verified downloads, transactional publication, managed-file ownership, rollback, and reports passed independent review after the user-authorized cancellation fix; focused tests, cargo check, and scoped formatting pass.
11. [x] Phase 6 rework attempt 3/3 independently reviewed PASS; process tests 14/14, pipeline tests 99/99, cargo check, and scoped rustfmt passed.
12. [x] Phase 7: migrated the Create UI to the shared pipeline, added the debug-only loopback Tauri MCP bridge, completed isolated read-only smoke tests, and passed independent review after local-source token cleanup.

## Recent Handoffs
### 2026-10-12 PQM → Reviewer
Task: `review_phase3` | Result: Phase-6 final review PASS; handle containment, cap disclosure, disappearance handling, and diagnostics-only behavior verified | Files: read-only review
### 2026-10-12 PQM → Implementer
Task: `pipeline_rework` | Result: Phase-7 implementation shared; worker hit usage limit before finishing verification; PQM resumed and corrected remote-only Java preview gating and Quilt review-only behavior in UI/backend | Files: pipeline commands, Create UI, Tauri bridge integration
### 2026-10-12 PQM → Reviewer
Task: `review_phase3` | Result: independent Phase-7 source review requested; pending | Files: read-only review
### 2026-10-12 PQM verification
Result: frontend production build PASS; `modpacks::pipeline` 103/103 and `servers::process` 14/14 PASS; offline `cargo check --lib` and scoped rustfmt PASS; debug Tauri MCP bridge smoke passed again after the source-token fix using unique identifier `com.blockserver.manager.mcpsmoke20261012b` and isolated app data | Files: Create UI, pipeline commands, transaction, Tauri config/capability
### 2026-10-12 PQM → Reviewer
Task: `review_phase3` | Result: preliminary review found local `.mrpack` picker tokens could accumulate after success; reviewer hit usage limit before final PASS/FAIL | Files: read-only review
### 2026-10-13 PQM → Reviewer
Task: `phase7_final_review` | Result: final independent review PASS; no actionable Phase-7 findings across token lifecycle, bridge exposure, command/API migration, provider boundaries, or Quilt placeholder | Files: read-only review

## Decisions & Constraints
- Set both initial and maximum JVM heap from each server's configured RAM; see `docs/architecture/adr/0010-match-configured-initial-server-heap.md`.
- Managed server commands use attached stdin only; detached RCON remains deferred until loopback-only binding is verified.
- Keep the newest 100 successful commands per server in SQLite; Clear is view-local and never truncates `logs/latest.log`.
- Child stdout/stderr pumping reads newline-delimited bytes, decodes lossily, preserves the `server://log/{id}` contract, and warns on real I/O errors.
- Preserve bounded console logging, process tracking, and explicit EULA behavior. EULA is never auto-accepted.
- Do not send commands to a user's live server or alter its process/log/database without explicit authorization.
- Rust MSRV is 1.90 to match Tauri 2.12.2. Approved dependencies: `tauri-plugin-dialog` 2.8.1, `tauri-plugin-opener` 2.7.0, debug-only `tauri-plugin-mcp-bridge` 0.13.1, `webview2-com` 0.39.1, and Windows `windows-core` 0.62.2. Do not add dependencies without explicit consent.
- CurseForge Core API/key integration and client-export file resolution remain gated. Website + local server-pack import does not use the API.
- Recognized new CurseForge imports: complete verified Forge/NeoForge archives and ServerPackCreator Fabric packs, including one nested ZIP wrapper. Unknown formats remain unsupported; Quilt imports remain unsupported while saved Quilt server behavior is preserved. See ADR-0013.
- Modrinth server installs include required/optional entries, skip `env.server=unsupported`, include entries with absent server metadata for backward compatibility, and do not fetch missing `recommends` dependencies. Fabric `depends.java` is checked before publication; this task revises when/how the runtime is selected.
- Modrinth automatic Java selection prefers the Minecraft-recommended major; Fabric Java metadata is parsed compatibly, constraints beyond available major precision are marked unverified, and the effective mod JAR set is checked before bulk overrides.
- Do not install Modrinth `env.server=unsupported` files or absent `recommends` automatically. Before publication, detect server-included Fabric `depends` entries whose required mod IDs are absent from the effective server mod set; report a pack incompatibility with the dependent mod and missing ID.
- CurseForge ZIPs stage under app data, are preserved by default, and only the app-managed copy may be deleted after successful publication when enabled. Archive-provided scripts are never executed.
- Do not modify the supplied servers/logs except for read-only diagnosis.
- The open-source survey does not justify adopting a replacement product or installer dependency; see `docs/research/2026-10-11-open-source-solutions-review.md`.
- CurseForge server-pack imports include validated Forge/NeoForge layouts and recognized ServerPackCreator Fabric archives only; do not generalize this to arbitrary Fabric or Quilt packs.
- The overhaul's scope is keyless CurseForge author server ZIPs, Modrinth remote/local packs, exact supported loaders, and a disabled Quilt placeholder; see ADR-0016 and the overhaul spec.

## Quality Gate Results
- Research/docs gate: PASS before implementation; independent plan review PASS.
- Phase-1 model review: PASS conditional on consumer-stage trust checks in ADR-0016/spec.
- Sandbox note: default-sandbox Cargo access to Tauri's cached build script is denied; the isolated C: target build and tests pass with the approved elevated offline check.
- Overhaul docs review: PASS; findings addressed before implementation.
- Copy/spec consistency review: PASS.
- CurseForge diagnostic review: PASS; no blocking findings.
- Phase-2 focused Cargo test: blocked before assertions by missing `OUT_DIR` at Tauri `generate_context!`; no test assertions executed.
- Phase-1 independent code review: PASS conditional on rederiving the active plan and applying the documented consumer-stage DB/root/hash/protected-path gates.
- Phase-2 independent review: PASS after scoped rework attempt 1/3; add explicit `server.jar` wrapper containing a valid Forge inner archive → Unsupported to the regression set.
- Phase-3 independent review: PASS after final scoped rework attempt 3/3. Cargo test attempts remain blocked before assertions by missing Tauri `OUT_DIR`.
- Phase-3 focused Cargo test: blocked before assertions by missing Tauri `OUT_DIR`; no test assertions executed.
- Phase-4 independent review: FAIL; rework attempt 1/3 required for Java validation ordering, loader redirect security, and the path-length boundary.
- Phase-4 rework attempt 1/3 independent review: PASS for the scoped loader implementation. ADR-0018 now limits the system-directory curl decision to loader metadata/artifact requests; Modrinth provider API executable resolution is tracked for pipeline/Create-flow integration.
- Phase-5 final gates: transaction tests 19/19, full `modpacks::pipeline` tests 90/90, `cargo check --lib` passed with 399 unwired/dead-code warnings, and scoped rustfmt passed across all 17 touched Rust files. Commands required sandbox escalation because the default sandbox denied the C: target.
- Phase-5 final independent review: PASS after the user-authorized cancellation fix. The bounded inner-ZIP copy polls cancellation, enforces the declared size, and cleans partial output while preserving the read-only guard through classification/extraction.
- Phase-6 final independent review: PASS after rework attempt 3/3. Opened handles are checked against the canonical root before reads; crash-report disappearance and scan limits disclose incomplete evidence; historical evidence stays diagnostics-only.
- Phase-6 final focused gates: process tests 14/14, `modpacks::pipeline` tests 99/99, `cargo check --lib` passed with expected phase-gated dead-code warnings, and scoped rustfmt passed for `process.rs` and `runtime.rs`.
- Phase-7 focused gates: frontend `npm run build` passed; `modpacks::pipeline` tests 103/103; `servers::process` regression tests 14/14; offline `cargo check --lib` passed with phase-gated dead-code warnings; scoped rustfmt passed for changed Rust modules.
- Phase-7 Tauri MCP smoke passed twice; the final smoke used debug bridge 0.13.1 on `127.0.0.1:9223`, unique test identifier `com.blockserver.manager.mcpsmoke20261012b`, and a dedicated `appDirectoriesOverride` scratch root. Backend metadata and the main-window DOM were inspected. No install/start command was invoked, and the app/session were stopped afterward.
- Phase-7 local-source lifecycle finding was closed: selected `.mrpack` tokens are released on success, source replacement, explicit release, or wizard unmount; failed/cancelled attempts retain their token for retry; related previews are dropped, and an in-flight preview cannot reinsert after release.
- Final independent Phase-7 code review: PASS; no actionable findings. Live pack installation and server process startup were not performed; provider/transaction behavior was verified with generated fixtures, and Tauri MCP smoke remained read-only.
- Archive fingerprinting rework: research/ADR-0017 documented official Windows CNG incremental hashing of both digests from a single bounded snapshot, with classification of the same snapshot; no new dependency or external hash executable.
- Phase-3 implementation scope: provider resolution and file-policy core only; keep Tauri handler/UI activation for the documented final migration phase.
- `cargo check --offline --manifest-path src-tauri/Cargo.toml`: blocked by missing `OUT_DIR` at `tauri::generate_context!` in `src-tauri/src/lib.rs`.
- `npm run build`: TypeScript phase passed; Vite failed with `EPERM` resolving `src/main.tsx`.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` and direct `rustfmt --check`: blocked by `Access is denied` while canonicalizing the H: workspace path.

Latest task archive: `.workflow/archive/2026-10-10_modrinth-missing-hard-dependencies.md`.
