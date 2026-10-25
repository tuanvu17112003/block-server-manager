# Console Stream Encoding Research

## Question

Why can the Console stop advancing while a managed Minecraft server remains running and `logs/latest.log` continues to grow?

## Observed Evidence

- The user-provided Console screenshot shows `Hasturian2` selected and marked attached. Visible output stops at 09:25:27. A separate screenshot shows a Java process in Running state. These images establish the reported state, but do not by themselves join that PID to a server folder.
- Read-only inspection of the user-provided `latest.log` showed later records at 09:25:54.
- Strict UTF-8 validation failed at byte offset 89331. The raw line at that location is `[09:25:27] [main/INFO]: New Bl\xE5haj common setup`; byte `E5` is not valid UTF-8 before the following ASCII `h`. Under Windows-1252 it represents `å`, but the file's encoding is not otherwise declared.
- The observed Console stop time matches the malformed log line. This is strong evidence for a child-pipe decoding failure, though the child stdout bytes were not independently captured, so the exact pipe bytes cannot be asserted from the file alone.

## Code Findings

- `src-tauri/src/servers/process.rs` starts Java with piped stdout and stderr and gives each pipe to a separate `pump_stream` thread.
- `pump_stream` iterates `BufRead::lines()`, emits each successful `String` over the existing `server://log/{id}` event, and breaks silently on any returned error.
- Rust documents `BufRead::lines()` items as `io::Result<String>` with the same errors as `read_line`; `read_line` errors when bytes are not valid UTF-8. This means a single undecodable line ends that pump thread. The separate Minecraft file appender can continue writing `latest.log`.
- The Console currently renders the in-memory event stream; the Phase 6 `logs_tail` IPC has no frontend caller. That omission is not required to explain this specific freeze, because the supplied file contains a malformed byte at the same timestamp.

## Decision for This Follow-Up

Read child output as newline-delimited bytes with `BufRead::read_until`, convert each line with `String::from_utf8_lossy`, and continue after malformed text. Keep the current event name/payload, CRLF handling, per-line size cap, and process ownership. Log a warning only when a genuine I/O error ends a reader. Do not add file polling, RCON, or live-server operations.

## Sources

- Rust `BufRead::lines` and `read_line` semantics: https://doc.rust-lang.org/std/io/trait.BufRead.html
- Rust `BufRead::read_until` reads byte vectors to a delimiter and only reports underlying I/O errors: https://doc.rust-lang.org/std/io/trait.BufRead.html#method.read_until
- Rust `Stdio` child-pipe behavior: https://doc.rust-lang.org/std/process/struct.Stdio.html
- Tauri `Emitter::emit` event behavior; the existing event channel stays unchanged: https://docs.rs/tauri/latest/tauri/trait.Emitter.html

## Bounded Line-Read Addendum (2026-10-12)

The 4 KiB event-line limit must apply while bytes are read, not after the complete line is buffered. Rust documents that `BufRead::read_until` appends all bytes through the delimiter and can keep reading forever if a peer never sends a newline. `fill_buf` exposes only the reader's current internal buffer, and `consume` advances by a count no greater than that buffer. A bounded implementation can scan each chunk for newline, retain at most 4 KiB, consume excess bytes without storing them, and continue until the line ends; then it can decode the retained prefix with `String::from_utf8_lossy`. This keeps memory bounded while preserving recovery after malformed or oversized lines. Genuine I/O errors still terminate that pipe reader and should be logged.

Source: Rust [`BufRead::fill_buf`, `consume`, and `read_until`](https://doc.rust-lang.org/std/io/trait.BufRead.html).

## Limitations

The fix affects newly started managed processes. A pump thread that already exited cannot reattach to the current Java process because its stdout handle was moved to and dropped by that thread. The current live server must not be stopped or restarted by the agent; the user can validate after choosing a safe restart window. No server command, process action, database change, or log write was performed during this investigation.
