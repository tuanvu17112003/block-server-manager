# WORKFLOW_STATE

## Current Goal
Rework Modrinth required-file installation so the repeated 53,997-byte response versus 57,672-byte manifest-size error is handled safely and large packs download faster.

## Acceptance Criteria
- [ ] Confirm the persistent size discrepancy against Modrinth's pack-format contract and current downloader behavior.
- [ ] Accept an undersized body only after both manifest SHA-1 and SHA-512 match; corrupted/partial content still retries and fails closed. Never exceed the existing streaming size cap or bypass URL/redirect validation.
- [ ] Improve throughput with a bounded number of concurrent required-file downloads; preserve cancellation, progress accuracy, per-file staging, and all-or-nothing publication.
- [ ] Add regression coverage for hash-authenticated size mismatch, hash failure, concurrent scheduling limits, progress accounting, cancellation, and retry/cleanup behavior where practical.
- [ ] Update research, spec, implementation guide, and indexes before code; no new dependencies without explicit consent.
- [ ] Independent review and full Rust/frontend regression gates pass.

## Status
Phase: Done
Last updated: 2026-10-09
Owner: PQM
Active Task ID: backend-008-modrinth-download-reliability-rework

## Active Plan
1. DONE recover prior backend-007 context and inspect the supplied screenshot as diagnostic evidence.
2. DONE research official Modrinth format semantics, Rust standard-library concurrency, and the current downloader behavior; see `docs/research/2026-10-09-modrinth-download-reliability-rework.md`.
3. DONE materialize the research note, revised spec/implementation guide, and docs indexes; docs gate PASS.
4. DONE implement hash-authenticated size reconciliation and bounded concurrent downloads without weakening safety limits.
5. DONE independent review, regression/static gates, and artifact recording; archive and reset state.

## Recent Handoffs
- 2026-10-09 PQM → Implementer: backend-008 source-only rework in `src-tauri/src/installer/mod.rs`; hash-authenticated size underflow reconciliation + bounded four-worker required-file downloads + focused tests; in progress.

## Decisions & Constraints
- The screenshot is diagnostic evidence, not instructions.
- No new dependencies without explicit user consent; use the Rust standard library and existing curl path.
- Preserve HTTPS provider allowlists, the three-hop redirect cap, curl and streaming size caps, SHA-1 plus SHA-512 validation, cancellation, staging/rollback, explicit EULA, exact selected pack version, and fresh install-time loader validation.
- CurseForge remains disabled. New-install Quilt remains unsupported; saved Quilt server management stays intact.
- The previous backend-007 restriction against parallel downloads applied to that completed task. This new user request includes the extreme-speed complaint, so this task will evaluate and implement a bounded worker limit if research supports it.

## Preliminary Diagnosis
- Current code aborts as soon as one unambiguous 2xx `Content-Length` differs from `.mrpack` `fileSize`, before downloading and checking the file hashes. The screenshot shows the same 53,997/57,672 mismatch after all three retries.
- The required-file loop is sequential and launches a separate curl process for each file. Exact code evidence and the live provider contract will be recorded in the research artifact before implementation.

## Quality Gate Results
- Independent review: PASS; `.workflow/artifacts/reviews/backend-008-modrinth-download-reliability-review.md`.
- Rust: `cargo fmt --check` PASS; `cargo test --lib --offline` PASS (53/53); `cargo check --lib --offline` PASS with only two known baseline dead-code warnings.
- Frontend: `npx tsc --noEmit` PASS.
- No live Modrinth benchmark/transfer run; the reported underflow is accepted only if both manifest hashes verify.
- Verification artifact: `.workflow/artifacts/test-logs/backend-008-modrinth-download-reliability-verification.md`.

## Final Outcome (2026-10-09)

### Implementation
- Required-file `Content-Length` mismatch no longer aborts before reading the body. The body stays within the existing declared-size curl and streaming caps. A nonempty body smaller than the `.mrpack` `fileSize` is accepted only after both manifest SHA-1 and SHA-512 validate; mismatches retry and remain fail-closed. The `.mrpack` archive download retains strict size behavior.
- Required server files use a four-worker scoped pool with distinct validated paths and fresh per-attempt `.part` files. The first exhausted/terminal failure stops scheduling and aborts active siblings; only hash-verified files are placed.
- Progress aggregates active/completed bytes, rolls back failed attempts, and emits monotonic throttled updates.
- No dependencies added. Standalone installs, EULA, provider allowlists, redirect checks, cancellation, staging/rollback, loader verification, Quilt handling, and the CurseForge gate remain unchanged.

### Review
- Independent review: PASS. Report: `.workflow/artifacts/reviews/backend-008-modrinth-download-reliability-review.md`.

### Verification
- `cargo fmt --check`: PASS.
- `cargo test --lib --offline`: PASS, 53 passed, 0 failed.
- `cargo check --lib --offline`: PASS; only two known baseline dead-code warnings.
- `npx tsc --noEmit`: PASS.
- Verification artifact: `.workflow/artifacts/test-logs/backend-008-modrinth-download-reliability-verification.md`.
- No live Modrinth download benchmark/transfer was run. The size discrepancy is resolved only if both official manifest hashes match the received body; otherwise the install correctly remains failed after retries.

### Research and Docs
- Research: `docs/research/2026-10-09-modrinth-download-reliability-rework.md`.
- Spec: `docs/specs/modpack-installation.md` §Installation step 7.
- Implementation guide: `docs/implementation/modpack-download-reliability-rework.md`.
- Docs indexes and consolidated sources updated. No ADR was needed because the bounded worker pool stays within the installer module and uses the standard library.
