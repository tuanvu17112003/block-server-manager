# WORKFLOW_STATE

## Current Goal
Prevent Modrinth installs from being published when their server-included Fabric mods have hard dependencies that the selected pack omitted or marked server-unsupported.

## Acceptance Criteria
- [x] Diagnose server `cca13e07-b05f-48ce-8587-d94df1c711cf` from its exact latest.log and installed-file/installer records.
- [x] Confirm the official `.mrpack` and Fabric rules for unsupported files and hard dependency resolution.
- [x] Design a bounded pre-publication dependency check that preserves client-only exclusions and does not fetch recommendations.
- [x] Materialize research/ADR/spec/checklist before code edits.
- [x] Implement the preflight and focused regressions, then independently review and verify.

## Status
Phase: Done
Last updated: 2026-10-10
Owner: PQM
Active Task ID: modrinth-missing-hard-dependencies

## Active Plan
1. [x] Correlate the latest log and installer record with the exact files installed and skipped.
2. [x] Research Fabric hard dependency/environment semantics and Modrinth `.mrpack` server policy; inspect current check paths with CodeGraph.
3. [x] Document the exact failure, safe behavior, and acceptance checklist before changing production code.
4. [x] Implement a bounded install-time check for missing hard Fabric dependencies; never silently install client-only or recommendation files.
5. [x] Independent review passed after three scoped corrections: skipped-path fixture/matcher, nested path traversal bounds, incomplete final status, and zip 2.4.2 duplicate-name limitation.
6. [x] Full regression/format/build checks passed; no live server or pack code was executed.

## Recent Handoffs
### 2026-10-10 PQM → Explorer
Task: `fabric_dependency_preflight_research` | Primary-source analysis of Fabric dependency resolution and bounded preflight design.
### 2026-10-10 PQM → Implementer
Task: `modrinth-missing-hard-dependencies` | Implement per ADR-0015 and `docs/implementation/modrinth-missing-hard-dependencies.md`; do not change server data or fetch skipped dependencies.
### 2026-10-10 PQM → Reviewer
Task: `review_modrinth_preflight` | PASS after rework; checked dependency scan, archive bounds, incomplete status, and unsupported-file policy.
### 2026-10-10 PQM → Quality Gate
Task: Regression/build verification | `cargo test --lib` 111/111; `cargo fmt -- --check`, `cargo build --lib`, and `npm run build` passed.

## Decisions & Constraints
- Set both initial and maximum JVM heap from each server's configured RAM; see `docs/architecture/adr/0010-match-configured-initial-server-heap.md`.
- Managed server commands use attached stdin only; detached RCON remains deferred until loopback-only binding is verified.
- Keep the newest 100 successful commands per server in SQLite; Clear is view-local and never truncates `logs/latest.log`.
- Child stdout/stderr pumping reads newline-delimited bytes, decodes lossily, preserves the `server://log/{id}` contract, and warns on real I/O errors.
- Preserve bounded console logging, process tracking, and explicit EULA behavior. EULA is never auto-accepted.
- Do not send commands to a user's live server or alter its process/log/database without explicit authorization.
- Rust MSRV is 1.90 to match Tauri 2.12.1. Approved dependencies: `tauri-plugin-dialog` 2.8.1, `tauri-plugin-opener` 2.7.0, `webview2-com` 0.39.1, and Windows `windows-core` 0.62.2. Do not add dependencies without explicit consent.
- CurseForge Core API/key integration and client-export file resolution remain gated. Website + local server-pack import does not use the API.
- Recognized new CurseForge imports: complete verified Forge/NeoForge archives and ServerPackCreator Fabric packs, including one nested ZIP wrapper. Unknown formats remain unsupported; Quilt imports remain unsupported while saved Quilt server behavior is preserved. See ADR-0013.
- Modrinth server installs include required/optional entries, skip `env.server=unsupported`, include entries with absent server metadata for backward compatibility, and do not fetch missing `recommends` dependencies. Fabric `depends.java` is checked before publication; this task revises when/how the runtime is selected.
- Modrinth automatic Java selection prefers the Minecraft-recommended major; Fabric Java metadata is parsed compatibly, constraints beyond available major precision are marked unverified, and the effective mod JAR set is checked before bulk overrides.
- Do not install Modrinth `env.server=unsupported` files or absent `recommends` automatically. Before publication, detect server-included Fabric `depends` entries whose required mod IDs are absent from the effective server mod set; report a pack incompatibility with the dependent mod and missing ID.
- CurseForge ZIPs stage under app data, are preserved by default, and only the app-managed copy may be deleted after successful publication when enabled. Archive-provided scripts are never executed.
- Do not modify the supplied servers/logs except for read-only diagnosis.

## Quality Gate Results
Research/docs complete (`docs/research/2026-10-10-modrinth-missing-hard-dependencies.md`, ADR-0015, spec/checklist). Reviewer: PASS. `cargo fmt -- --check`: PASS; `cargo test --lib`: 111/111; `cargo build --lib`: PASS; `npm run build`: PASS. No live server was started, no pack/mod code executed, and the supplied server/logs were read-only.
