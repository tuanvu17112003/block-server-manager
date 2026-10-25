# WORKFLOW_STATE (archived 2026-10-10 — curseforge-embedded-download-handoff)

## Current Goal
Fix the embedded CurseForge server-pack download handoff that stalls after the website countdown while external-browser downloads succeed.

## Acceptance Criteria
- [x] Permit only the secure CurseForge download CDN navigation needed to complete official website downloads; preserve the embedded browser's isolated permissions.
- [x] Add regression coverage for accepted CDN hosts, HTTPS-only enforcement, and lookalike-host rejection.
- [x] Preserve existing Tauri/WebView2 staging, progress, cancellation, and all other app workflows.
- [x] Independent review, relevant Rust regression tests, Cargo check, formatting, and frontend build pass.
- [x] Clearly distinguish code verification from a live WebView2 download, which requires an on-device smoke test.

## Status
Phase: Done
Last updated: 2026-10-10
Owner: PQM
Active Task ID: none

## Active Plan (completed)
1. Record the report and official WebView2/CurseForge redirect findings under docs before implementation. — Done (research `docs/research/2026-10-10-curseforge-embedded-download-handoff.md` existed; 1 stale line fixed in rework)
2. Delegate the narrow host-allowlist fix and tests to the implementer. — Resolved verify-only: Explorer found the allowlist + tests already present in source; user approved verify-only path.
3. Independently review the change, run the workflow test gate, and update this state. — Done (Reviewer PASS, Tester PARTIAL→PASS after scoped fmt rework).

## Recent Handoffs
### 2026-10-10 Explorer → PQM
Task: `curseforge-embedded-download-handoff` code map | Result: complete — `allowed_curseforge_navigation` already permits HTTPS `curseforge.com` + `forgecdn.net` with tests; research line 12 stale | Files: `src-tauri/src/modpacks/curseforge_import.rs:1901-2000`
### 2026-10-10 Reviewer → PQM
Task: `curseforge-embedded-download-handoff-review` | Result: PASS (code) + 2 stale-docs flags (research:12, implementation:17) | Files: `src-tauri/src/modpacks/curseforge_import.rs`, capabilities, docs
### 2026-10-10 Tester → PQM
Task: `curseforge-embedded-download-handoff-test` | Result: PARTIAL — lib 77/77 PASS, navigation 4/4 PASS, cargo check PASS, `npm run build` PASS; `cargo fmt --check` FAIL (2 diffs in `curseforge_import.rs`) | Files: `src-tauri/src/modpacks/curseforge_import.rs`
### 2026-10-10 Fixer → PQM
Task: `curseforge-embedded-download-handoff` scoped rework 1/3 | Result: complete — `cargo fmt` formatting only, 2 stale doc lines fixed; re-verified fmt PASS, lib 77/77 PASS, navigation 4/4 PASS | Files: `src-tauri/src/modpacks/curseforge_import.rs`, 2 docs

## Decisions & Constraints (durable — retained in live state)
- Set both initial and maximum JVM heap from each server's configured RAM; see `docs/architecture/adr/0010-match-configured-initial-server-heap.md`.
- Managed server commands use attached stdin only; detached RCON remains deferred until loopback-only binding is verified.
- Keep the newest 100 successful commands per server in SQLite; Clear is view-local and never truncates `logs/latest.log`.
- Child stdout/stderr pumping reads newline-delimited bytes, decodes lossily, preserves the `server://log/{id}` contract, and warns on real I/O errors.
- Preserve bounded console logging, process tracking, and explicit EULA behavior.
- Do not send commands to a user's live server or alter its process/log/database without explicit authorization.
- Rust MSRV is 1.90 to match Tauri 2.12.1. Approved dependencies: `tauri-plugin-dialog` 2.8.1, `tauri-plugin-opener` 2.7.0, `webview2-com` 0.39.1, and Windows `windows-core` 0.62.2.
- CurseForge Core API/key integration and client-export file resolution remain gated. The website + local server-pack import flow does not use the API.
- Initial CurseForge import support is limited to validated Forge/NeoForge packs. Vanilla/Paper/Fabric remain unsupported pending exact markers; Quilt imports remain unsupported while saved Quilt server behavior is preserved.
- CurseForge ZIPs stage under app data, are preserved by default, and only the app-managed copy may be deleted after successful publication when the user enables the setting. Archive-provided scripts are never executed.

## Task-specific notes (not carried to live state)
- Key discrepancy: research + implementation docs described the allowlist as `curseforge.com`-only, but source already contained the `forgecdn.net` allowlist + 4 navigation tests. Resolved verify-only per user approval; stale lines fixed.
- Code verification is static + unit-level only. The redirect-host chain for file 9094783 was never traced live; if CurseForge uses a CDN host outside `curseforge.com`/`forgecdn.net`, navigation will still block. Live Windows smoke test with the Prominence II 4.1.3 SERVER ZIP remains user-owned.
- Repo has no git commits (all files untracked); no tracked-base diff available.

## Quality Gate Results
- Reviewer: PASS (code meets CDN allowlist criteria)
- Tests (incl. regression): PASS — lib 77/77, focused `curseforge_import` 13/13, navigation 4/4; 0 failures, 0 ignored
- Cargo check: PASS (2 pre-existing dead-code warnings in `src/util/events.rs`, unrelated)
- Frontend build (`npm run build`): PASS (49 modules)
- Formatting: PASS after scoped rework 1/3 (`cargo fmt`, logic untouched)
- Live WebView2 smoke: NOT exercised (user-owned)
- Rework attempts: 1/3
