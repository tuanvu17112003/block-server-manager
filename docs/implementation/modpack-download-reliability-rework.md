# Implementation Guide — Modrinth Download Reliability Rework (backend-008)

Read first: `docs/research/2026-10-09-modrinth-download-reliability-rework.md`, `docs/specs/modpack-installation.md` §Installation step 7.

## Scope and constraints

- Owned code path: `src-tauri/src/installer/mod.rs` required-file download, progress aggregation, and focused unit tests.
- No new dependencies. Use Rust standard-library scoped threads with a four-file maximum.
- Preserve HTTPS provider allowlists, manual per-hop redirect validation and three-hop cap, response-header cap, curl total/connect/low-speed timeouts, `--max-filesize`, streaming upper cap, fresh attempt `.part` files, SHA-1 and SHA-512 checks, cancellation, staging cleanup, and atomic placement/publication.
- Do not change the `.mrpack` archive's one-attempt download, standalone installers, frontend mocks, loader selection, EULA, saved Quilt support, or CurseForge gate.

## Ordered implementation

1. Remove `Content-Length != fileSize` as an immediate abort. Continue downloading within the existing declared-size cap. Keep parsing a single unambiguous final response length only for diagnostics.
2. For each required file, validate the received size. If it matches `fileSize`, continue as before. If it is smaller and nonzero, verify both manifest SHA-1 and SHA-512; accept and log the metadata discrepancy only when both match. Any hash failure is retryable; an oversized body remains rejected by curl and the streaming cap.
3. Build all safe target paths and parent directories before starting workers. Run required-file tasks through a scoped worker pool capped at four. Each worker retries only its own file with a fresh `.part`; successful files are hash-verified before placement. The first terminal/exhausted failure stops new work and aborts active siblings; return the original failure so outer staging cleanup runs.
4. Aggregate active/completed bytes atomically. On a failed attempt, subtract that attempt's counted bytes before retry. Serialize progress emission so snapshots remain monotonic and throttle updates to the existing two-second cadence. Keep log writes to per-file/attempt events rather than transfer ticks.
5. Keep UI completion reporting based on the fully verified plan total. A size-underflow accepted by hash must still only publish after every required file and the later install validation pass.

## Acceptance and verification

- Unit tests: smaller nonzero size accepted only after hash success; mismatch plus hash failure remains an error; empty and oversized content do not enter the accepted-underflow path; worker count never exceeds four; failure stops further scheduling; progress rollback and retry accounting are correct.
- Regression: `cargo fmt --check`, `cargo test --lib --offline`, `cargo check --lib --offline`, and `npx tsc --noEmit`.
- Independent review: retry/failure classification, cleanup, worker stop/cancellation races, monotonic progress, no safety-cap weakening, no dependency changes.
- No live provider benchmark is assumed by unit tests; record the absence of a live Modrinth smoke test if none is available.
