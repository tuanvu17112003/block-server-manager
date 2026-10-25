# WORKFLOW_STATE

## Current Goal
Make the app launch servers with an initial Java heap equal to the configured maximum, matching the user's working `start.bat` behavior.

## Acceptance Criteria
- [x] Trace app launch mode and compare the user's BAT, JAR, mod JAR, and Java runtime.
- [x] Research Java 17 heap/G1 behavior and materialize research, ADR, spec, and implementation guide before code.
- [x] Pass `-Xms` equal to configured RAM alongside existing `-Xmx` in Jar and argument-file launch modes.
- [x] Add focused Rust regression coverage and run formatting/tests/check/build.
- [x] User-run desktop launch smoke test; the user confirmed the rebuilt app/server is OK.

## Status
Phase: Done; user-run desktop smoke confirmed OK.
Last updated: 2026-10-10
Owner: PQM
Active Task ID: backend-018-server-initial-heap

## Recent Handoffs
- backend-017 launch review: app now passes both heap bounds from the configured RAM. JAR and 442 mod JARs matched the successful BAT copy. Research: `docs/research/2026-10-10-server-initial-heap.md`.
- backend-015 console performance: build/review passed; live output and search remained responsive. Evidence: `.workflow/artifacts/test-logs/backend-015-console-performance-and-start-test.md`.

## Decisions & Constraints
- Set the initial and maximum Java heap to the server's configured RAM size.
- Preserve Java path validation, server working directory, process marker, loader args, EULA gate, and process tracking.
- Do not execute `start.bat` or add older Aikar/G1 tuning flags; the user's latest requested command is only `-Xms8G -Xmx8G`.
- Keep the Modrinth all-files install policy and bounded console log behavior unchanged.

## Quality Gate Results
- Research/docs gate: PASS.
- `cargo fmt --check`: PASS.
- `cargo test --lib --offline`: PASS, 55 passed, 0 failed; two existing dead-code warnings.
- `cargo check --bin mc-server-manager --offline`: PASS.
- `cargo build --bin mc-server-manager --offline`: PASS.
- Independent reviewer: PASS.
- Desktop app retest: user reports the check is OK; no independent startup evidence was shared.

## Next Step
User confirmed the check is OK. The archived verification report remains `.workflow/artifacts/test-logs/backend-018-server-initial-heap.md`.
