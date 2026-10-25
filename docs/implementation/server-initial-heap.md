# Implementation Guide: Match Initial and Maximum Server Heap

## Owned paths

- `src-tauri/src/servers/process.rs` — construct both heap arguments from `ServerRecord.ram_mb` for Jar and argument-file launch modes; add focused formatting regression coverage.

## Constraints

- Do not invoke `start.bat`.
- Preserve Java validation, current working directory, process marker, loader argument files, EULA gate, and stdout/stderr tracking.
- Do not add GC tuning flags beyond the user-provided `-Xms`/`-Xmx` pair.

## Verification checklist

- [x] Test heap arguments for 8,192 MB and a second RAM size.
- [x] `cargo fmt --check` and `cargo test --lib --offline` pass.
- [x] `cargo check --bin mc-server-manager --offline` and debug app build pass.
- [ ] User-run desktop launch smoke test; the user chose to perform this check.

Build/test evidence: `.workflow/artifacts/test-logs/backend-018-server-initial-heap.md`.
