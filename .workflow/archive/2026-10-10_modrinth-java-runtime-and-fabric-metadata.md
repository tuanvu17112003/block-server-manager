# WORKFLOW_STATE

## Current Goal
Correct the Modrinth install preflight so valid Fabric metadata does not block installation and incompatible Java is resolved before expensive pack setup.

## Acceptance Criteria
- [x] Reproduce both screenshot failures against current code and actual local mod metadata.
- [x] Match Java dependency interpretation to Fabric's supported `fabric.mod.json` version predicates, including alternative arrays.
- [x] Do not reject a valid mod JAR because the scanner's strict JSON parser cannot parse metadata syntax Fabric accepts; retain a safe, bounded compatibility scan.
- [x] Choose or request a compatible Java runtime before large server overrides are applied; avoid late failure after gigabytes of work.
- [x] Materialize current research, ADR/spec/checklist before code changes, then independently review and verify.

## Status
Phase: Done
Last updated: 2026-10-10
Owner: PQM
Active Task ID: modrinth-java-and-metadata-preflight

## Active Plan
1. [x] Trace current Modrinth Java detection/selection, Java constraints scan, install ordering, and UI readiness with CodeGraph.
2. [x] Inspect actual BetterEnd metadata and existing server logs; research official Fabric predicate/parser semantics.
3. [x] Materialize research note, ADR, spec, and implementation checklist before production code.
4. [x] Revise Java selection/provisioning and metadata preflight with bounded, best-effort parsing.
5. [x] Independent review passed after scoped rework for predicate precision, cancellation, cleanup, and the override conflict fixture.
6. [x] Quality gates passed; see results below. The two originally specified `latest.log` paths were not found in the current app-data tree; separate existing Fabric logs confirmed Better End loads.

## Recent Handoffs
### 2026-10-10 PQM → Implementer
Task: `modrinth-runtime-fabric-metadata` | Implement per ADR-0014 and checklist `docs/implementation/modrinth-runtime-and-fabric-metadata.md`; no unrelated cleanup or new dependencies.
### 2026-10-10 PQM → Reviewer
Task: `review_modrinth_preflight` | PASS after two scoped reworks; major/patch precision, cancellation, cleanup, and override conflict assertions verified.
### 2026-10-10 PQM → Quality Gate
Task: Regression/build verification | 100/100 Rust tests, Rust formatting, Rust library build, and frontend production build passed.

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
- CurseForge ZIPs stage under app data, are preserved by default, and only the app-managed copy may be deleted after successful publication when enabled. Archive-provided scripts are never executed.
- Do not modify the supplied servers/logs except for read-only diagnosis.

## Quality Gate Results
Research/docs: complete (`docs/research/2026-10-10-modrinth-runtime-and-fabric-metadata.md`, ADR-0014, spec/checklist). Reviewer: PASS after two scoped reworks. `cargo fmt -- --check`: PASS; `npm run build`: PASS; `cargo test --lib`: 100/100; `cargo build --lib`: PASS. No live server was started and no pack scripts were executed.
