# Implementation Guide — Backend Phase 6 Console

Read first: [`../specs/console-backend.md`](../specs/console-backend.md), [`../research/2026-10-10-console-backend-phase6.md`](../research/2026-10-10-console-backend-phase6.md), and [`backend-plan.md`](backend-plan.md) §Phase 6.

## Approved Scope

The user approved tracked-stdin command delivery, a per-server SQLite history capped at 100 successful commands, and view-local Clear behavior. Detached RCON is deferred by [ADR-0011](../architecture/adr/0011-defer-detached-rcon-until-loopback-binding-is-verified.md). Do not enable RCON or generate an RCON password.

## Owned Paths

- `src-tauri/src/db/mod.rs` for an additive command-history schema.
- `src-tauri/src/servers/` for bounded log-tail and history storage helpers.
- `src-tauri/src/cmds/` and `src-tauri/src/lib.rs` for the typed IPC handlers and registration.
- `src-tauri/src/servers/process.rs` for successful-send history integration.
- Rust tests colocated with the new pure helpers and database operations.
- Keep frontend files out of scope for this backend task unless an IPC type declaration in `src/tauri.ts` is required to make the backend contract consumable.

## Implementation Steps

1. Add the additive SQLite representation and a per-server, bounded history API using the approved retention and data-at-rest rules.
2. Implement read-only tailing of `logs/latest.log`, with validated paths, a hard maximum line count, short-lived handles, and explicit missing/locked/rotating-file behavior. Verify the opened handle's resolved path remains inside the captured canonical log directory (Win32 final-handle path on Windows, `/proc/self/fd` descriptor path on Linux); fail closed on other targets until verified.
3. Add typed Tauri handlers and register them; preserve the existing live log event name and payload.
4. Integrate history only after stdin write/flush succeeds. The existing frontend owns the optimistic command echo; do not emit a duplicate `server://log/{id}` command echo.
5. Keep detached RCON out of this task.

## Verification Checklist

- [x] Tail returns only the newest requested lines, handles missing files and partial final lines, and remains bounded on large logs.
- [x] Windows read-only access works while the server writes; each request opens a fresh handle.
- [x] Reparse-point replacement cannot redirect the opened handle outside the captured log directory on Windows/Linux; independent review passed.
- [x] Linux uses nonblocking open and rejects a FIFO replacement before reading; the Linux-only test is included but was not run on this Windows host.
- [x] Command validation, per-server isolation, ordering, retention, and delete cascade have focused Rust coverage.
- [ ] Live Tauri managed-child `list`/`say` smoke and injected stdin write-failure test not run.
- [x] RCON remains disabled; no RCON credentials are generated or stored.
- [x] `cargo fmt --check`, full Rust tests, `cargo check`, `cargo build`, and `npm run build` pass. Frontend source was unchanged.
- [x] Independent review checked path safety, DB locking, handler registration, Windows file sharing, echo behavior, and the RCON boundary.

## Current Status

Backend implementation and independent review are complete. Detached RCON remains deferred pending a supported, cross-loader loopback-only bind design. The Linux target and live Tauri/game smoke were not available on this Windows-only verification run; unsupported non-Windows targets fail closed.
