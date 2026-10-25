# Console Child-Stream Resilience Specification

## Goal

Keep managed-server Console output flowing when a child stdout/stderr line contains bytes that are not valid UTF-8.

## Requirements

1. Split child output by newline at the byte level so invalid text does not terminate the reader.
2. Convert undecodable sequences to Unicode replacement characters and continue with later lines.
3. Preserve current CRLF stripping, one event per line, the `server://log/{id}` channel and string payload, and the 4096-byte truncation limit.
4. Process a final unterminated line at EOF as the current `Lines` iterator does.
5. Continue to stop on genuine unrecoverable I/O errors, but record a warning with the server ID and error instead of failing silently.
6. Do not change process lifecycle, server commands, `logs/latest.log`, Clear behavior, RCON, or frontend historical hydration.

## Acceptance Criteria

- A byte stream with an invalid UTF-8 byte in one line emits a replacement character for that byte and still emits subsequent lines.
- CRLF and EOF-terminated lines preserve the existing line boundaries and remove line-ending bytes.
- Oversized lines remain truncated without panicking when the limit falls inside a multi-byte character.
- Existing server stdout/stderr events retain their channel and payload contract.
- Focused Rust tests, Rust formatting, backend check/build pass; independent review passes.
- User can verify a newly launched managed server continues to advance in Console after a non-UTF-8 line. The agent does not restart or send commands to a live server.
