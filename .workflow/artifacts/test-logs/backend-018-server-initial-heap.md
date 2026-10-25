# Backend-018 Server Initial Heap Change

Date: 2026-10-10  
Task: `backend-018-server-initial-heap`

## Change

The app now passes `-Xmx<ramMb>M` and `-Xms<ramMb>M` for both direct-JAR and argument-file launch modes. It retains Java path validation, the server working directory, the process identity marker, EULA validation, and piped output tracking. It does not execute `start.bat` or add the older custom Aikar flags.

## Checks

- `cargo fmt --check`: PASS.
- `cargo test --lib --offline`: PASS, 55 passed, 0 failed. Two pre-existing dead-code warnings remain in `src/util/events.rs`.
- `cargo check --bin mc-server-manager --offline`: PASS; same two dead-code warnings.
- `cargo build --bin mc-server-manager --offline`: PASS.
- Independent code review: PASS.

## Desktop launch retest

- Not run by the agent. The user said they will test the rebuilt app themselves, so no desktop launch result is claimed here.
- The user-provided BAT screenshot shows that a server copy starts with an 8 GB initial and maximum heap. Earlier local comparison found the same `server.jar` hash and identical 442 mod JARs between the app-managed copy and the BAT copy.
