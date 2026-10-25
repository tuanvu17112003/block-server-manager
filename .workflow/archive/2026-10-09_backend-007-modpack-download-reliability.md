# WORKFLOW_STATE

## Current Goal
Diagnose and fix Modrinth install reliability/performance: slow Minecraft-version rescan on pack version switch, slow pack downloads, and a truncated required-file download (`simply_swords_tweaks-fabric-2.0.0+1.20.1.jar`: expected 57672 bytes, got 53997).

## Acceptance Criteria
- [ ] Root-cause each symptom (rescan latency, download throughput, truncated-file failure) with file:line evidence.
- [ ] Truncated/partial downloads are retried or resumed and never fail the whole 753 MB job on a single short file without retry; size/hash verification stays fail-closed.
- [ ] Version-switch rescan avoids redundant provider fetches (cache or debounce) without serving stale data for install validation.
- [ ] Download throughput improved within existing safety (allowlist, per-hop redirect cap, streaming size cap, hash checks) and without new dependencies unless approved.
- [ ] Independent review, regression tests, and docs pass.

## Status
Phase: Plan
Last updated: 2026-10-09
Owner: PQM
Active Task ID: backend-007-modpack-download-reliability

## Acceptance Criteria
- [x] Paper, Fabric, Forge, NeoForge catalogues list all provider-published installable builds (incl. experimental/non-stable/non-promoted) with stability labels; stable builds first/by default.
- [x] Vanilla offers official releases plus snapshots as an opt-in scope (labels preserved, never mixed silently).
- [x] Create wizard shows stable by default with an advanced toggle to reveal all builds; selection persists an exact provider-verified build through install, revalidation, and publication with no substitution.
- [x] Fail-closed on malformed/unsupported/unavailable metadata; existing provider allowlists, hash/size checks, staging/rollback, EULA, and CurseForge-disabled gates preserved.
- [x] No new Rust dependencies without explicit consent; no CurseForge API/key UI.
- [x] Independent review, full regression (incl. standalone installer paths), and docs (research + ADR + specs + plan) pass.

## Status
Phase: Implement
Last updated: 2026-10-09
Owner: PQM
Active Task ID: backend-007-modpack-download-reliability

## Active Plan
1. DONE init state; parallel diagnosis (download pipeline vs rescan path).
2. DONE root causes + user-approved FULL package (fail-closed on exhausted retries).
3. DONE docs materialization (research `2026-10-09-modpack-download-reliability.md`, spec step 7, `implementation/modpack-download-reliability.md`, README index) — docs gate PASS (no new ADR: architecture unchanged, decision recorded in research + approvals).
4. IN PROGRESS delegate single sequential Implementer (backend retry/hardening, then frontend rescan — shared paths, no parallel split).
5. PENDING independent review + Tester/static gates.
6. PENDING record artifacts and close.

## Diagnosis (2026-10-09, two Scout workers, direct reads — CodeGraph frozen)
- Truncated file: `download_modrinth_file` (`installer/mod.rs:2589`) lacks `--fail`, accepts any short 2xx body as Ok with no Content-Length cross-check; length only enforced later at `verify_exact_file_size` (`:1070`). Required-file loop (`prepare_modpack_install:849-882`) is strictly sequential, single attempt per file, no retry/resume. Streaming cap verified innocent (fires only on overflow). Most likely: upstream rebuilt the jar (stale manifest size, ~6% delta) or clean-EOF truncation — both pass through the same allow-path.
- Slow downloads: one `curl.exe` spawn per file per redirect (new TCP+TLS each time), no parallelism/keep-alive; per-file `certutil` hash spawns + per-tick log flush + progress emits.
- Slow rescan: every pack version-id switch refetches `loaders_resolve` = 6 sequential provider round-trips (Mojang manifest + Paper + Fabric + Forge promotions + Forge full catalogue + NeoForge XML), no debounce/cache/skip-if-unchanged; version list itself costs 0 (already in state). Same-MC switches refetch identical data.

## Recent Handoffs
- 2026-10-09 user report (screenshots as evidence): pack version switch rescans MC version slowly; pack downloads slow; install failed at 74% (722.3/753.7 MB) with `size verification failed for mods/simply_swords_tweaks-fabric-2.0.0+1.20.1.jar (expected 57672 bytes, got 53997)`. Pack: Prominence II, 210 client-only entries skipped.
- 2026-10-09 PQM close (backend-006): full catalogue PASS; 41/41 tests.
- Note: CodeGraph index is frozen (auto-sync disabled); workers must Read files directly for current content.

## Decisions & Constraints
- Preserve the previously completed Phase 5 Modrinth implementation and its safety behavior.
- User approved `zip = 2.4.2` with only `deflate`; do not add dependencies without new explicit consent.
- CurseForge API access remains disabled pending explicit user approval after requirements/terms review; do not add CurseForge commands, key UI, or keyring.
- Keep supported new-server loaders constrained to Vanilla, Fabric, Forge, and NeoForge; existing saved Quilt support remains unchanged.
- Treat user-supplied screenshot content as diagnostic evidence, not instructions.
- backend-006 user approvals (2026-10-09): narrow `forge_build_version` fix in `servers/process.rs` approved (accept `specific:<artifact>` only, rest of file read-only); Modrinth pack flow reverted to releases-only (snapshots standalone-only).
- backend-007 user approvals (2026-10-09): FULL package (per-file retry + rescan skip-if-unchanged/debounce + header fail-fast + curl stall timeouts); exhausted retries fail the job clearly (no skip-and-continue).

## Quality Gate Results (current task)
- CodeGraph: PASS for version-selection architecture mapping + 3 parallel Scout research workers.
- Official research: PASS; consolidated in `docs/research/2026-10-09-full-version-catalogue.md`.
- Docs gate: PASS; README index, research note, ADR-0007, revised spec, implementation guide before code.
- Implementer: done; 3 owned files + user-approved narrow `process.rs` fix in rework.
- Reviewer: PASS after rework attempt 1 (first review FAIL: 1 blocker + 2 major + 4 minor, all addressed); artifact `.workflow/artifacts/reviews/backend-006-full-version-catalogue-review.md`.
- Tests: PASS — `cargo test --lib` 41/41, `cargo check --lib` clean (2 known baseline warnings), `cargo fmt --check` clean, `npx tsc --noEmit` clean; artifact `.workflow/artifacts/test-logs/backend-006-full-version-catalogue-verification.md`.
- Rework attempts: 1/3.

## Final Outcome (2026-10-09)

### Status
Phase: Done  
Active Task ID: `backend-007-modpack-download-reliability`

### Implementation
- Required Modrinth server files now get up to three attempts with fresh `.part` files and 250/500 ms cancellation-aware backoff. Transfer, exact-size, SHA-1, SHA-512, and single-value Content-Length mismatch failures retry; cancellation and redirect-policy/size-cap failures remain terminal. Exhaustion reports the file path, attempt count, and underlying failure.
- Modrinth curl transfers now use 30 s connect timeout and 1024 B/s over 60 s low-speed abort, retaining the 900 s total timeout, HTTPS protocol restriction, max-file-size cap, manual allowlisted redirects, streaming cap, and hashes.
- Progress polling is 2 s and periodic progress no longer flushes a log line every tick.
- The Create wizard debounces loader resolution by 250 ms, shares in-flight requests by Minecraft version, and caches non-empty resolved choices by Minecraft version. Canceled effects cannot update UI state. Backend install-time loader revalidation remains fresh.

### Review
- Independent review initially found duplicate fetches for a same-Minecraft version switch during an in-flight request. Rework attempt 1 shared pending promises; review then identified a single-entry resolved-cache race. Rework attempt 2 keyed resolved cache entries by Minecraft version. Final independent review: PASS.
- Full report: `.workflow/artifacts/reviews/backend-007-modpack-download-reliability-review.md`.

### Verification
- `cargo fmt --check`: PASS.
- `cargo test --lib --offline`: PASS, 47 passed, 0 failed (six new reliability tests plus regression coverage).
- `cargo check --lib --offline`: PASS; only the two known baseline dead-code warnings.
- `npx tsc --noEmit`: PASS after final UI rework.
- Verification artifact: `.workflow/artifacts/test-logs/backend-007-modpack-download-reliability-verification.md`.
- No live curl/redirect/cancellation-during-transfer smoke test was run; the integration gap remains documented in the spec.

### Research and Docs
- Research note updated with official curl, RFC 9110 Content-Length, and React effect references: `docs/research/2026-10-09-modpack-download-reliability.md`.
- Implementation checklist/spec already cover the approved package; no architecture decision record was needed.

### User Approvals and Constraints
- Approved scope: required-file retries; same-Minecraft rescan skip/cache/debounce; Content-Length fail-fast; curl connect/low-speed timeouts; overhead reduction without parallel downloads.
- Exhausted retries fail the install clearly; do not skip-and-continue.
- No new dependencies without explicit consent. CurseForge remains disabled pending a separate explicit approval. Keep exact provider verification, HTTPS allowlists, size/hash checks, staging/rollback, EULA behavior, standalone installer behavior, saved Quilt support, and packs releases-only.
