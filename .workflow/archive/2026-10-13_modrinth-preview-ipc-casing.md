# WORKFLOW_STATE

## Current Goal
Fix Modrinth modpack review failures caused by the Tauri source-request IPC contract; expose useful backend string errors.

## Acceptance Criteria
- [x] Reproduce the user's screenshot in an isolated Tauri app and identify the exact deserialization error.
- [x] Materialize Serde research, a source-request contract spec, and a focused implementation checklist before code changes.
- [x] Deserialize remote Modrinth, local mrpack, and CurseForge source variants from frontend-shaped camelCase JSON.
- [x] Preserve primitive Tauri string errors in the Create wizard instead of replacing them with a generic fallback.
- [x] Reproduce the screenshot's exact Modrinth project/version through preview in scratch app data without invoking install or starting a server.
- [x] Run focused Rust tests, Rust check/format, and frontend build.
- [x] Independent read-only source review PASS.

## Status
Phase: Done
Last updated: 2026-10-13
Owner: PQM
Completed Task ID: modrinth-preview-ipc-casing

## Active Plan
1. [x] Trace the screenshot failure with CodeGraph and isolate the reproduction from user app data.
2. [x] Verify Serde's enum field naming behavior against official docs and record the root cause.
3. [x] Add docs before implementation.
4. [x] Apply `rename_all_fields = "camelCase"`, add variant deserialization regressions, and surface string IPC errors.
5. [x] Build, run focused tests/format checks, and independently review.

## Recent Handoffs
### 2026-10-13 PQM investigation
Result: isolated direct invoke reproduced `missing field project_id`; JS receives the Tauri rejection as a primitive string. After the code change, the exact Cobblemon 1.8.2/1.21.1/Fabric preview succeeded with 77 file decisions using dedicated scratch app data; no install or server start was invoked.
### 2026-10-13 PQM verification
Result: Rust IPC contract tests 3/3 PASS; `cargo check --lib --offline` PASS; scoped rustfmt PASS; `npm run build` PASS; exact Cobblemon preview 77 files PASS in scratch app data | Independent review PASS.
### 2026-10-13 PQM → Reviewer
Task: `review_modrinth_ipc` | Result: independent source review PASS; all source variants, nested loader, string error reporting, and provider integrity gates verified | Files: read-only review

## Retained Project Guardrails
- Keep CurseForge keyless and require author-provided server ZIPs; do not resolve client exports through an API key.
- Keep Quilt unavailable for new installs while preserving existing saved-server behavior.
- Never alter a user's saved server database, process, logs, or pack data for a smoke test; use dedicated scratch app directories.
- EULA acceptance remains explicit. Never execute scripts from pack archives or auto-remove missing dependencies.
- Verify exact pack and loader pins, content integrity, paths, redirects, cancellation, and transaction rollback before publication.
- Preserve user-owned and untracked files; only verified manager ownership records authorize managed-file cleanup.
- Tauri MCP Bridge 0.13.1 is debug-only, loopback-bound, and scoped to the main window. Do not register it in production builds.
- Rust MSRV 1.90; approved Tauri 2.12.2, dialog 2.8.1, opener 2.7.0, MCP bridge 0.13.1, webview2-com 0.39.1, and Windows windows-core 0.62.2. Do not add dependencies without explicit consent.

## Quality Gate Results
- Serde research/docs gate: PASS before implementation.
- Initial isolated Tauri reproduction: PASS; root cause was the source enum's variant fields deserializing snake_case while TypeScript sends camelCase; Tauri rejected as a string, which the UI replaced with the fallback message.
- Focused Rust IPC tests: 3/3 PASS; `cargo check --lib --offline` PASS; scoped rustfmt PASS; frontend `npm run build` PASS.
- Exact Cobblemon 1.8.2 preview with source ID `5FFgwNNP`/`BpTjgzL8`: PASS with 77 file decisions in a dedicated scratch app root. No install or server process was started.
- Independent review: PASS with no actionable findings.

## Previous Task Archive
`.workflow/archive/2026-10-13_modpack-server-setup-overhaul.md`
