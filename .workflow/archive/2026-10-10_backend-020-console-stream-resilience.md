# Archived Workflow State: backend-020-console-stream-resilience

Archived on 2026-10-10 at the user's request after they confirmed, “It work.”

## Current Goal
Keep managed-server Console output flowing when a child process emits a line containing non-UTF-8 bytes.

## Acceptance Criteria
- [x] Confirm from the supplied screenshots that the selected server is visible and Java is running.
- [x] Identify a malformed byte in the supplied `latest.log` at the timestamp where Console output stops.
- [x] Complete CodeGraph exploration, Explorer research, and Planner review.
- [x] Materialize research, spec, and implementation checklist before code changes.
- [x] Make the stdout/stderr pump tolerate invalid UTF-8 and continue emitting later lines.
- [x] Pass focused Rust regression tests, formatter, cargo check, and independent review.
- [x] User verified the Console works in the running app; screenshot shows continuing log output from 10:12:19 through 10:12:21.

## Status
Phase: Done
Last updated: 2026-10-10
Owner: PQM
Task ID: backend-020-console-stream-resilience

## Active Plan and Results
1. Re-read `WORKFLOW.md`, `WORKFLOW_STATE.md`, and Phase 6 Console docs; map the event-only Console and existing bounded `logs_tail` API with CodeGraph.
2. Explorer traced child stdout/stderr pipes to `server://log/{id}` and the frontend in-memory log store. The Console did not use the separate `logs_tail` IPC.
3. Read-only inspection of the user-provided log found byte `0xE5` at offset 89331 in `[09:25:27] [main/INFO]: New Bl\xE5haj common setup`; later 09:25:54 entries existed. Rust `BufRead::lines()` returns an error for invalid UTF-8, and the old pump silently stopped on any error.
4. Materialized `docs/research/2026-10-10-console-stream-encoding.md`, `docs/specs/console-stream-resilience.md`, and `docs/implementation/backend-020-console-stream-resilience.md` before implementation.
5. Implementer changed only `src-tauri/src/servers/process.rs`: newline-delimited byte reads, lossy decoding, same CRLF/EOF and safe 4096-byte truncation behavior, warning for actual I/O errors, three focused tests.
6. Independent review PASS: `.workflow/artifacts/reviews/backend-020-console-stream-resilience-review.md`.
7. Rust verification PASS: fmt, 64/64 library tests, and `cargo check`; details: `.workflow/artifacts/test-logs/backend-020-console-stream-resilience.md`.
8. The agent's native binary build attempt could not replace `src-tauri/target/debug/mc-server-manager.exe` because Windows returned Access Denied. No app/server process was closed or altered. The user later verified the Console fix in the running app; exact binary build provenance was not captured.

## Recent Handoffs
- Explorer `explorer_console_lag` — event-only Console; pump can stop on read/decode errors; no frontend tail caller.
- Planner `planner_console_lag` — recommended separate narrow stream-resilience follow-up; preserve lifecycle and no-command constraints.
- Implementer `implement_console_stream` — byte-safe pump and three focused tests; one owned source file.
- Reviewer `review_console_stream` — PASS; optional gap is no injected I/O-error/event-emission test.
- Tester `test_console_stream` — PASS; 64 Rust tests, fmt, check; app build output locked.
- User — confirmed the Console works; screenshot shows continuing output during server startup.

## Decisions & Constraints
- Preserve Phase 6 attached-stdin-only commands; detached RCON remains deferred.
- Store newest 100 successful commands per server; Clear is view-local and never truncates `logs/latest.log`.
- Preserve `server://log/{id}` event contract. Child log pumps use lossy decoding so malformed bytes do not suppress later lines; genuine I/O errors are warned.
- Do not send commands to a user's live server, or alter its process, database, or log without explicit authorization.

## Quality Gate Results
- CodeGraph, research/docs, independent review, Rust tests, formatting, and backend check: PASS.
- User Console smoke: PASS per user confirmation and screenshot.
- Two existing dead-code warnings remain (`server_players_event`, `metrics_tick_event`).
- Separate backend-019 `list`/`say` command smoke was user-owned and was not performed by the agent; this archive does not claim it passed.
- Rework attempts for this task: 0/3.
