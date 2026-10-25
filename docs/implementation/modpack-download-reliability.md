# Implementation Guide — Modpack Download Reliability (backend-007)

Read first: `docs/research/2026-10-09-modpack-download-reliability.md`, `docs/specs/modpack-installation.md` §Installation step 7.

## Pre-implementation gates

- User-approved scope (2026-10-09): FULL package — bounded per-file retry, rescan skip-if-unchanged + debounce, header fail-fast, curl stall timeouts. Exhausted retries fail the job clearly.
- No new Rust dependencies without explicit consent. No CurseForge changes. No parallelism in this task (overhead reduction only).
- Preserve: HTTPS allowlist + 3-redirect cap, streaming size cap, SHA-1+SHA-512 checks, staging/rollback, cancellable jobs, explicit EULA, backend-005 exact-build behavior, backend-006 catalogue behavior, Quilt rejection, packs releases-only.
- CodeGraph index is frozen — confirm all line numbers by direct Read before editing.

## Owned paths

- Backend: `src-tauri/src/installer/mod.rs` (only): `download_modrinth_file` (~2589), `stream_download_body` (~2830, read-only reference — do not weaken), required-file loop (`prepare_modpack_install:849-882`), `verify_exact_file_size` (~1070, unchanged semantics).
- Frontend: `src/tabs/Create.tsx` (only): pack version-switch effect chain (`:209-228`, `:319-373`, `:510-536`).
- Forbidden: new commands/signatures, `modpacks/*` URL policy, `servers/*`, mocks, docs (PQM owns).

## Ordered steps

1. **Header fail-fast** — after a 2xx response in `download_modrinth_file`, compare the dumped-headers `Content-Length` (only when exactly one unambiguous value is present) against the expected size; on mismatch remove artifacts and return a retryable validation error logging both values. Lengthless responses keep flowing (log at debug level), failing later at the size check as today.
2. **Bounded per-file retry** — wrap the per-file sequence (download + size + SHA-1 + SHA-512) in the required-file loop with N tries (suggest 3 total attempts) and a small backoff; fresh `.part`/header files per try; log each attempt (`retry {n}/{max} for {path}: {reason}`); final failure returns the existing exact-size/hash error annotated with the attempt count. Cancellation checks between tries. The `.mrpack` archive download keeps single-attempt behavior (unchanged).
3. **Curl stall hardening** — add `--connect-timeout` (suggest 30 s) and a low-speed abort (`--speed-limit`/`--speed-time`, e.g. 1024 B/s over 60 s) to the modpack curl invocation only; keep `--max-time 900`, `--proto =https`, `--max-filesize`, `--dump-header`, manual redirects. New timeout errors surface through the existing curl-exit path and are retryable under step 2.
4. **Overhead reduction (no parallelism)** — coarsen the per-tick progress/metadata check (700 ms → ~2 s) and avoid flushing `installer.log` on every tick for file downloads; keep final per-file completion lines. No behavior change to progress ranges.
5. **Rescan skip-if-unchanged + debounce** — in the `343-373` effect: skip `tauriVersions.loaders` when `modrinthInstallMc` equals the already-loaded `modrinthBuildMc` with non-empty choices and no error (just re-key the version id); add a short debounce (~200-300 ms, matching the existing search pattern) so rapid version scrubbing coalesces. Install-time `beginInstall` validation path untouched and always fresh.

## Verification checklist

- Unit tests (existing `#[cfg(test)]` modules): header-mismatch → retryable error; lengthless → flows through; retry succeeds-on-second-try via injected attempt stub (or pure helper tests for attempt classification: which errors are retryable vs terminal — cancellation/redirect-policy/path errors must NOT retry); backoff/cap constants asserted; stale-guard frontend logic covered only if cheaply testable (else reviewer-verified by reading).
- Regression: full `cargo test --lib`, `cargo check --lib` (no new warnings), `cargo fmt --check`, `npx tsc --noEmit`.
- Review: retryable/terminal error split, temp-file cleanup per try, no weakened caps, install-time freshness intact, no silent substitution in the rescan skip.
