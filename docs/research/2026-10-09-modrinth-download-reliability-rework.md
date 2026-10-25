# Research — Modrinth Download Reliability Rework (backend-008)

Date: 2026-10-09  
Trigger: User reports the exact size error persisted after backend-007 retries and that a 753.7 MB pack download remains extremely slow. The supplied screenshot shows `simply_swords_tweaks-fabric-2.0.0+1.20.1.jar`, expected size 57,672 bytes, `Content-Length` 53,997 bytes, after three attempts at 67% (528.3 MB / 753.7 MB).

## Findings

### Repeated size failure

- Current `download_modrinth_file` (`src-tauri/src/installer/mod.rs:2711`) aborts a 2xx transfer as soon as one unambiguous `Content-Length` differs from the pack's `fileSize`. The required-file loop (`:854`) retries that same URL three times, but never receives the body on this path and never reaches either file hash check. This explains why the user still sees the same 53,997/57,672 error after all attempts.
- The evidence is consistent with a stable size-metadata/CDN representation discrepancy; it does not prove whether the bytes themselves are partial. The implementation must decide from the downloaded bytes and the manifest hashes.
- Modrinth's official `.mrpack` format defines `fileSize` as a byte size “mostly provided as a utility for launchers to allow use of progress bars”; the file `hashes` object **must** contain SHA-1 and SHA-512. Therefore a smaller body may be accepted only after both exact manifest hashes pass. A hash mismatch remains retryable and fatal after the bounded attempts. Keep the declared size as the streaming upper bound; never accept an oversized body based on a header.

### Slow transfers

- Required files are downloaded in a sequential `for` loop. Each item launches its own `curl.exe` process, so files do not overlap and each process pays its own connection setup cost. The previous two-second progress throttle reduced local overhead but did not address this serialized network bottleneck.
- Use a fixed four-worker ceiling over the already validated, distinct required-file paths. Each worker keeps the existing manual redirect validation, HTTPS allowlist, size cap, isolated `.part` file, retry policy, both hash checks, and atomic placement. Stop scheduling and abort sibling transfers on the first exhausted or terminal failure; the surrounding installer still removes staging on failure.
- Rust's standard `thread::scope` has been stable since 1.63, below this crate's declared Rust 1.77 MSRV. No new dependency is needed. The shared progress reporter aggregates active and completed bytes and emits monotonic, throttled updates; per-attempt bytes are rolled back from progress on retry.

## Sources

- Modrinth, [Modrinth Modpack Format (`.mrpack`)](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack) — required SHA-1/SHA-512 hashes and `fileSize` purpose.
- Rust standard library, [`std::thread::scope`](https://doc.rust-lang.org/stable/std/thread/fn.scope.html) — bounded scoped workers can borrow the task's install/control state; available since Rust 1.63.
- curl, [command-line manual](https://curl.se/docs/manpage.html) — `--parallel` supports a configurable concurrency ceiling. This implementation uses the existing per-file curl invocation to retain application-controlled per-hop redirects and streaming caps.
- Modrinth, [Prominence II official project page](https://modrinth.com/modpack/prominence-2-fabric) — identifies the user-reported pack; no assumption is made about a specific version ID not visible in the screenshot.

## Decision boundary

- Treat declared `fileSize` and HTTP `Content-Length` as bounds/progress metadata, not payload identity. Accept a smaller received size only after both required hashes match exactly. Retain the existing upper size cap and fail closed for hash mismatch, overflow, unsupported redirects, invalid URLs, and cancellation.
- No standalone loader, browser-mock, CurseForge, EULA, server publication, or dependency behavior changes. No architectural record is needed because the bounded worker pool stays within the installer module and uses only the existing standard library.
