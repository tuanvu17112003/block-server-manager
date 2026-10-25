# Backend Phase 6 Console Specification

Status: Accepted (2026-10-10); detached RCON is deferred by [ADR-0011](../architecture/adr/0011-defer-detached-rcon-until-loopback-binding-is-verified.md).

## Scope

Backend-only portion of Phase 6: retrieve bounded history from a server's `logs/latest.log`, preserve the current live `server://log/{id}` stream, deliver commands to a tracked server over stdin, and persist command history per server. Detached RCON is deferred. Frontend replacement of mocks, Clear/Export UI behavior, chips, and confirmation flows are outside this task.

## Contracts

- `logs_tail(id, limit)` validates the server ID, reads only that server's `logs/latest.log`, and returns the newest bounded lines. The default limit is 1,000 and the hard maximum is 10,000. It does not hold the file open after the request. Missing history returns an empty list. The live event channel remains unchanged.
- `server_send_command(id, cmd)` keeps the existing single-line validation and tracked-stdin path. It records the command only after the write and flush succeed. Stopped or untracked servers continue to return a not-found error. The existing frontend performs the optimistic echo; the backend does not emit a duplicate echo.
- `server_command_history(id, limit)` returns commands for that server, newest first, with timestamps. Retention is the newest 100 successful sends per server, stored as plaintext in the local SQLite database and deleted with its server row. Failed sends are not stored. This backend task does not wire the frontend history UI.
- Existing Clear is a view-local action. No backend clear command or truncation of the server-owned `latest.log` is included. Reloading history may therefore show older file lines again.

## Detached RCON Gate

The backend plan called for RCON when no managed stdin handle exists. The project also requires RCON to bind only to `127.0.0.1`. Current server configuration disables RCON, and the documented Paper properties do not expose an independent RCON bind address. The user approved deferring detached RCON. The implementation must not enable RCON or make an unaudited assumption about `server-ip`.

## Acceptance Criteria

- History requests validate IDs, tolerate a missing file, bound the requested line count, and read a concurrently written/rotating file without writing to or truncating it. On Windows and Linux, the opened file handle must resolve beneath the captured canonical log directory so a concurrent symlink/reparse replacement cannot redirect the read. Linux opens nonblocking and rejects FIFO replacements before reading. Other non-Windows targets fail closed until handle-path containment is implemented for that platform.
- Live `server://log/{id}` events continue unchanged and are not persisted twice by the log-tail path.
- Commands remain single-line and nonempty. A stopped/untracked process or failed stdin write does not create a history item.
- Successful sends are stored for the correct server, ordered newest first, and capped at 100 entries per server. The existing frontend echo remains unchanged and the backend does not emit another echo.
- Server deletion cascades its command history.
- Detached RCON remains disabled and no RCON password is generated or stored by this implementation.
