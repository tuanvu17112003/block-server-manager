# Backend Phase 6 Console Research

Date: 2026-10-10
Task: `backend-019-console-backend`

## Current Backend

- `server_send_command` validates a single nonempty line and writes it to the stdin of a child currently tracked by `ProcessState`.
- Starting a server creates a managed Java child with piped stdin/stdout/stderr. Stdout and stderr are sent as `server://log/{id}` events; they are not persisted by the launcher.
- The application stops managed servers during normal window shutdown and does not reattach to their processes at the next launch. Startup orphan recovery verifies and terminates eligible stale processes, then marks saved records stopped. The planned "detached" RCON path therefore needs a definition beyond an ordinary Tauri-managed process.
- Server directories contain `logs/`; the backend plan identifies `logs/latest.log` as the historical log source. Current scaffold and install properties disable RCON and omit its password.
- SQLite uses one mutex-protected connection and additive schema setup. It has no console history table or command-history IPC.
- Browser console logs and command history are mock/in-memory data. Existing backend log events are already consumed by the store.

## External Findings

- Paper's server-properties reference documents `enable-rcon`, `rcon.password`, and `rcon.port`. It documents `server-ip` as the address to bind and says blank binds to all interfaces; it does not document a separate RCON bind-address property. The available contract does not establish how to guarantee a loopback-only RCON listener independently of the game listener. Do not assume that changing `server-ip` is an RCON-only setting. [PaperMC server.properties](https://docs.papermc.io/paper/reference/server-properties/)
- Minecraft RCON uses the Source RCON protocol over TCP. The protocol has authentication and command packets and response framing that needs bounded parsing. RCON is not encrypted, so the project rule that it binds to `127.0.0.1` is a security boundary, not a preference. [Minecraft RCON protocol reference](https://minecraft.wiki/w/RCON), [Valve Source RCON protocol](https://developer.valvesoftware.com/wiki/Source_RCON_Protocol)
- Rust's Windows `OpenOptionsExt` documentation says the default sharing mode includes read, write, and delete, allowing compatible concurrent reads and rename/delete operations while a handle is open. Windows still rejects opens whose requested access conflicts with the sharing mode on an existing handle. Tail reads should be read-only, short-lived, and return a useful error if the server's handle prevents access. [Rust OpenOptionsExt](https://doc.rust-lang.org/stable/std/os/windows/fs/trait.OpenOptionsExt.html), [Microsoft CreateFile sharing modes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea)
- The existing Cargo manifest has no direct RCON client dependency. The project workflow forbids installing dependencies without explicit user consent; a small synchronous client could use the standard TCP APIs, but this is not a reason to proceed without resolving the listener-binding issue.

## Approved Resolution

On 2026-10-10 the user approved backend Phase 6 with attached stdin only and detached RCON deferred. The user also approved a per-server local SQLite history capped at the newest 100 successful sends, with Clear remaining view-local and no truncation of `latest.log`. See [ADR-0011](../architecture/adr/0011-defer-detached-rcon-until-loopback-binding-is-verified.md).

The existing frontend already echoes commands optimistically. The backend will not emit a second command echo; it will persist the command only after the stdin write and flush succeed. A failed backend send can still leave the existing frontend's optimistic row visible, which is outside this backend-only task.

## Review Rework 1 — Open-Handle Path Validation

The independent review found a time-of-check/time-of-use gap between `symlink_metadata(latest.log)` and a separate `OpenOptions::open(latest.log)`. A concurrent replacement could make the later open follow a reparse point after the path check.

Microsoft documents `FILE_FLAG_OPEN_REPARSE_POINT` as opening the final reparse point itself instead of following it, and `GetFinalPathNameByHandleW` as returning the resolved final path for an open handle. The Windows fix opens with that flag, rejects a reparse-point handle, resolves the handle's final path, and requires it to remain beneath the canonical log directory before reading. Linux `/proc/self/fd` entries link to the actual open files; resolving the current process's descriptor path provides the equivalent post-open containment check. Other non-Windows targets fail closed until they have a verified handle-path implementation. [Microsoft CreateFile flags](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea), [Microsoft GetFinalPathNameByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew), [Linux kernel man-pages book: proc_pid_fd](https://www.kernel.org/pub/linux/docs/man-pages/book/man-pages-6.06.pdf)

## Review Rework 2 — Nonblocking Linux Open

The independent reviewer found that a FIFO replacing `latest.log` on Linux could block in `open` before the handle type was checked. Linux `open(2)` documents that FIFO opens block until another endpoint is opened unless nonblocking mode is requested; `O_NONBLOCK` has no effect on regular files. The Linux branch therefore opens with `O_NONBLOCK`, checks the opened handle is a regular file, then resolves `/proc/self/fd/<fd>` and checks containment. [Linux `open(2)`](https://man7.org/linux/man-pages/man2/open.2.html)
