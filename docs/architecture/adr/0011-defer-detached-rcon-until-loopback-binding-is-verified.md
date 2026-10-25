# ADR-0011: Defer detached RCON until loopback binding is verified

## Status

Accepted (2026-10-10)

## Context

Backend Phase 6 planned an RCON fallback when a server has no tracked stdin handle. Project security rules require RCON to bind only to `127.0.0.1` and require generated passwords never to be logged. The documented Vanilla/Paper server-properties contract exposes RCON enablement, password, and port, but no independent RCON bind-address setting. `server-ip` controls the game listener and cannot be changed to loopback as an RCON-only measure. The app also stops managed servers on normal window close and does not reattach to untracked processes after restart.

## Decision

For backend Phase 6, deliver server log tailing and per-server command history, and send commands only to a process currently tracked by `ProcessState` through its stdin pipe. Defer detached RCON. Keep RCON disabled, generate no RCON password, add no RCON dependency, and do not truncate the server-owned `logs/latest.log` for the existing view-local Clear action. Persist the newest 100 successfully sent commands per server in local SQLite.

Reconsider detached RCON only after a supported, cross-loader mechanism demonstrates loopback-only binding without changing the game listener. Record that design in a new ADR before implementation.

## Consequences

- Tracked Tauri-managed servers retain command support through stdin; stopped or untracked processes reject commands.
- Existing frontend command echo and view-local Clear behavior stay unchanged. The backend does not emit a duplicate command echo or add a log-clear command.
- Command history is local plaintext in the app database, per server, capped at 100 entries, and cascades on server deletion.
- Detached command support remains unavailable until a loopback-safe RCON design is approved and implemented.
