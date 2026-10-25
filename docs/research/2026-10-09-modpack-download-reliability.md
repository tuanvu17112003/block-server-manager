# Research — Modpack Download Reliability & Rescan Latency (backend-007)

**Accessed:** 2026-10-09
**Scope:** three user-reported symptoms on Prominence II installs — slow MC rescan on pack version switch, slow pack downloads, truncated required-file failure (`simply_swords_tweaks-fabric-2.0.0+1.20.1.jar`: expected 57672, got 53997 at 74% / 722.3 MB of 753.7 MB). Two Scout workers investigated by direct reads (CodeGraph index frozen).

## 1. Truncated file: accepted as success, caught only at size check

- `download_modrinth_file` (`src-tauri/src/installer/mod.rs:2589-2828`) invokes `curl.exe` **without** `--fail` and runs a manual redirect loop. `Ok(())` requires body/stderr join ok, no overflow flag, curl exit 0, 2xx headers, destination exists — but performs **no `Content-Length` vs expected-size cross-check and no minimum-size check**. Any short 2xx body returns `Ok`; length is enforced only later by `verify_exact_file_size` (`:1070-1078`, exact `!=`).
- The required-file loop (`prepare_modpack_install:849-882`) is strictly sequential with a single attempt per file (`?` per step) — no retry, no `Range`/resume (no `Range`, `--retry`, `Content-Range`, or `206` handling anywhere in the download path; only metadata fetches have bounded 429-only retry).
- `stream_download_body` (`:2830-2853`) verified innocent: overflow always errors; underflow writes everything and returns `Ok` — the cap cannot produce a short file.
- Mechanism ranking: (1) upstream rebuilt the jar, manifest size stale (~6% delta fits a rebuild, not a torn packet); (2) clean-EOF truncation with exit 0 (no usable length header, else curl exit 18 would have fired first); (3) redirect landing on a different object; (4, unlikely) local partial write — ruled out (`write_all` errors fail before the size check).

## 2. Slow downloads: process-per-file, fully sequential

- One `curl.exe` spawn per file per redirect (new TCP+TLS each time, no keep-alive reuse, no parallelism). Per-file post cost: two `certutil.exe -hashfile` spawns plus rename. Per-tick cost every 700 ms: `fs::metadata` + `log.append` (write+flush) + Tauri progress emit. Only a total `--max-time 900` guard; no connect timeout or low-speed abort, so a stalled file can hold the worker up to 15 min.

## 3. Slow rescan: 6 provider round-trips per version switch

- `Create.tsx` heavy effect (`:343-373`) refetches `tauriVersions.loaders(mc)` on every `selectedModrinthVersionId` change — no debounce, no cache, no skip-if-unchanged, even when the MC is identical (only the version ID changed). The version list itself costs 0 (already in state); `versions_vanilla`/`versions_paper` are mount-once.
- `resolve_loader_choices` is strictly sequential with 6 HTTPS round-trips (Mojang manifest, Paper builds, Fabric loaders, Forge promotions, Forge full catalogue, NeoForge XML), each a fresh `curl.exe` spawn, no cache, `control=None` so abandoned selections still run to completion.
- Redundant work: same-MC switches refetch identical data; full Vanilla+Paper+Fabric+Forge+NeoForge matrix built when the UI only needs one loader family; Mojang manifest re-downloaded seconds after the UI already filtered on it.

## 4. Agreed fix package (user-approved 2026-10-09)

- Bounded per-file retry on download/size/hash failure (small backoff, fresh `.part` per try); exhausted retries fail the job clearly with attempt counts in the log (no skip-and-continue).
- Rescan skip-if-unchanged + debounce for same-MC switches (frontend); install-time validation keeps doing fresh uncached revalidation — UI hints never trusted at install.
- Header fail-fast: compare `Content-Length` (when present and unambiguous) against expected size right after 2xx; mismatch is a retryable error.
- Curl stall hardening: `--connect-timeout` + low-speed abort alongside existing `--max-time`, `--proto =https`, `--max-filesize`, manual redirects, streaming cap.
- Throughput only via overhead reduction (coarser ticks, batched log flush); no parallelism in this task.
- Constraints carried over: HTTPS allowlist + 3-redirect cap, streaming size cap, SHA-1+SHA-512 checks, staging/rollback, explicit EULA, no new dependencies without consent, CurseForge stays disabled.

## 5. Primary-source checks for the approved implementation

Checked 2026-10-09 against the current official documentation:

- curl's command-line manual says `--connect-timeout` bounds only connection setup, while `--speed-limit` plus `--speed-time` abort a transfer that remains below the configured bytes-per-second threshold. Keep the existing `--max-time` as the overall cap; the new options cover connection setup and sustained stalls. See [curl command-line manual](https://curl.se/docs/manpage.html).
- RFC 9110 says a known representation length should be sent as `Content-Length` absent `Transfer-Encoding`, and notes repeated/comma-combined equal values can occur. This implementation therefore compares only one parseable value from the final response block; ambiguous/malformed values are not trusted as authoritative. Exact file size and SHA-1/SHA-512 remain the required fail-closed checks. See [RFC 9110 §8.6](https://www.rfc-editor.org/rfc/rfc9110.html#name-content-length).
- React runs an Effect's cleanup before setting it up again for changed dependencies. Retaining the existing cancellation guard while adding the debounce prevents obsolete loader responses from updating the current selection. See [React `useEffect`](https://react.dev/reference/react/useEffect).
