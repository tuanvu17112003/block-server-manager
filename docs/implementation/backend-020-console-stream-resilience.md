# Backend 020: Console Stream Resilience

Status: Done; independent review, Rust test gates, and user Console smoke passed.

## Owned Paths

- `src-tauri/src/servers/process.rs`

All other paths are read-only unless the PQM explicitly updates the handoff.

## Ordered Steps

1. Replace strict UTF-8 `BufRead::lines()` consumption in `pump_stream` with newline-delimited byte reads and lossy UTF-8 decoding.
2. Preserve line ending handling, the existing 4096-byte cap, and the `server://log/{id}` event payload.
3. Emit a tracing warning for a genuine I/O error that ends the stream pump; malformed text must not take this path.
4. Factor a small reader helper if needed to unit-test invalid bytes followed by valid lines, CRLF, final unterminated data, and safe truncation at a UTF-8 boundary.
5. Keep the existing process lifecycle, stdin command path, RCON deferral, and disk log behavior unchanged.

## Verification

- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib --offline`
- `cargo check --manifest-path src-tauri/Cargo.toml --bin mc-server-manager --offline`
- Build the Windows app/binary if available in the current environment.
- Independent Reviewer checks decoding semantics, line boundary compatibility, truncation, log contract, and scope.
- User-owned smoke: PASS. The user reports “It work”; the screenshot shows Console output continuing across 10:12:19–10:12:21 while the server is attached/running. No `list`, `say`, or other command was sent by the agent.

## Results (2026-10-10)

- `cargo fmt --manifest-path src-tauri/Cargo.toml --check` passed.
- `cargo test --manifest-path src-tauri/Cargo.toml --lib --offline` passed (64/64).
- `cargo check --manifest-path src-tauri/Cargo.toml --bin mc-server-manager --offline` passed.
- Independent review passed; report: `.workflow/artifacts/reviews/backend-020-console-stream-resilience-review.md`.
- The agent's native binary build attempt did not finish: Cargo could not remove the existing `src-tauri/target/debug/mc-server-manager.exe` (`Access is denied`). The app/process was not closed or modified. The user later verified the fix in the running app; exact binary build provenance was not captured. Report: `.workflow/artifacts/test-logs/backend-020-console-stream-resilience.md`.
- Two existing dead-code warnings remain (`server_players_event`, `metrics_tick_event`).
- Live user verification passed for a newly running app/server. This patch cannot reattach the reader for a process whose old pump already exited.
- Separate backend-019 `list`/`say` command smoke remains user-owned and unperformed by the agent; no server command was sent.

## Constraints and Risks

- Lossy decoding can replace malformed text, but it must not suppress the rest of the stream.
- A real I/O failure remains terminal for that particular pump and should be visible in tracing output.
- A pump that already exited cannot be reattached to a running process; this patch cannot recover the current session without a user-managed restart.
- No IPC, frontend, DB, RCON, server-folder, or live process changes are part of this task.
