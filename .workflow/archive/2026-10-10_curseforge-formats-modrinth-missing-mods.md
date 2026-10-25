# WORKFLOW_STATE

## Current Goal
Make supported CurseForge server-pack ZIP variants install as runnable servers and correct Modrinth server-pack installation failures indicated by the supplied logs.

## Acceptance Criteria
- [x] Identify the supported CurseForge server-pack download/export layouts, including both supplied archives, and distinguish them from client exports or incomplete/unsupported packs.
- [x] Implement secure installation that preserves required server files, libraries, loader launch metadata, overrides, and platform launch configuration without executing archive scripts.
- [x] Diagnose the supplied Modrinth logs against the actual installer flow and correct causes of missing dependencies/mods or loader errors.
- [x] Materialize current research, architecture decision, feature spec, and implementation checklist before production code changes.
- [x] Review changed paths and report verification performed and any remaining limits.

## Status
Phase: Done
Last updated: 2026-10-10
Owner: PQM
Active Task ID: none

## Active Plan
1. Read workflow and inspect supplied archives/logs plus CodeGraph installation flows. Done.
2. Research official CurseForge/Modrinth format and install semantics. Done.
3. Materialize docs tree research, ADR, spec, and implementation checklist. Done: `docs/research/2026-10-10-server-pack-formats-and-modrinth-startup.md`, `docs/architecture/adr/0013-server-pack-format-and-server-mod-policy.md`, `docs/specs/server-pack-install-correctness.md`, and `docs/implementation/server-pack-correctness.md`.
4. Implement the documented import and dependency/runtime fixes. Done.
5. Independent review PASS. `cargo test --lib`: 92 passed; `cargo fmt -- --check`: PASS; `cargo build --lib`: PASS. Live server install/start was not run.

## Recent Handoffs
### 2026-10-10 Reviewer → PQM
Task: `server-pack-correctness-review` | Result: PASS after rework; five archive/manifest safety findings resolved | Files: `src-tauri/src/modpacks/curseforge_import.rs`, `src-tauri/src/modpacks/install.rs`, `src-tauri/src/installer/mod.rs`
### 2026-10-10 Implementer → PQM
Task: `server-pack-correctness-implementation` | Result: implemented CurseForge nested/SPC support, Forge ignoreList fix, Modrinth env policy, and Fabric Java checks | Files: three Rust modules listed above
### 2026-10-10 Tester → PQM
Task: `curseforge-formats-modrinth-missing-mods-test` | Result: PASS — 92/92 library tests, fmt PASS, build PASS | Files: changed backend + focused inline tests
### 2026-10-10 Tester → PQM
Task: `curseforge-inspect-unicode-path-test` | Result: PASS — lib 85/85, check PASS, fmt PASS, build PASS; 0 regressions | Files: changed backend + inline tests

## Decisions & Constraints
- Set both initial and maximum JVM heap from each server's configured RAM; see `docs/architecture/adr/0010-match-configured-initial-server-heap.md`.
- Managed server commands use attached stdin only; detached RCON remains deferred until loopback-only binding is verified.
- Keep the newest 100 successful commands per server in SQLite; Clear is view-local and never truncates `logs/latest.log`.
- Child stdout/stderr pumping reads newline-delimited bytes, decodes lossily, preserves the `server://log/{id}` contract, and warns on real I/O errors.
- Preserve bounded console logging, process tracking, and explicit EULA behavior.
- Do not send commands to a user's live server or alter its process/log/database without explicit authorization.
- Rust MSRV is 1.90 to match Tauri 2.12.1. Approved dependencies: `tauri-plugin-dialog` 2.8.1, `tauri-plugin-opener` 2.7.0, `webview2-com` 0.39.1, and Windows `windows-core` 0.62.2.
- CurseForge Core API/key integration and client-export file resolution remain gated. The website + local server-pack import flow does not use the API.
- New CurseForge imports support complete verified Forge/NeoForge archives and recognized ServerPackCreator Fabric metadata packs, including one nested ZIP wrapper. Other formats remain unsupported until exact markers and fixtures are validated; Quilt imports remain unsupported while saved Quilt server behavior is preserved. See ADR-0013.
- Modrinth server install includes required/optional entries, skips `env.server=unsupported`, and includes entries with absent server metadata for backward compatibility. Do not fetch missing `recommends` dependencies. Fabric `depends.java` constraints are checked before publication.
- CurseForge ZIPs stage under app data, are preserved by default, and only the app-managed copy may be deleted after successful publication when the user enables the setting. Archive-provided scripts are never executed.
- Embedded CurseForge browser permits HTTPS `curseforge.com` + `forgecdn.net` (exact + true subdomains) only; `on_new_window=Deny`; capabilities remain `windows:["main"]`. See `.workflow/archive/2026-10-10_curseforge-embedded-download-handoff.md`.
- Free-space queries resolve the containing directory before the Win32 call; file-leaf Unicode content never affects volume resolution. See `.workflow/archive/2026-10-10_curseforge-inspect-unicode-path.md`.

## Quality Gate Results
Reviewer: PASS after rework. Tests: 92/92. Lint/format: `cargo fmt -- --check` PASS. Build: `cargo build --lib` PASS. Limitation: no live installation or server start was performed; user data and pack scripts were untouched.
