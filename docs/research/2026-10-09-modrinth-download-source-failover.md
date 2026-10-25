# Research — Modrinth Download Source Failover (backend-009)

Date: 2026-10-09  
Trigger: After backend-008, the user supplied a new install screenshot reporting `SHA1 mismatch` for `mods/simply_swords_tweaks-fabric-2.0.0+1.20.1.jar` after three attempts. The previous size-metadata failure is now past the transfer stage and is being rejected by the manifest integrity check.

## Recovered context and pre-change behavior

- The completed backend-008 task is archived at `.workflow/archive/2026-10-09_backend-008-modrinth-download-reliability-rework.md`. It fixed the earlier `Content-Length`/`fileSize` discrepancy by allowing a smaller nonempty body only after both manifest hashes validate, and bounded required-file transfers to four workers.
- At task start, `src-tauri/src/modpacks/install.rs` considered only the first URL from each file's `downloads` array: it stored that URL if trusted, otherwise rejected the entry without checking later candidates.
- At task start, `src-tauri/src/installer/mod.rs` retried a retryable file failure up to three times, but passed that same stored URL on every attempt. A payload failing SHA-1/SHA-512 was therefore retried from the same source.
- The supplied screenshot does not include the selected pack version or its `.mrpack` manifest. It therefore cannot establish whether this specific entry contains more than one candidate URL. The source-selection gap is confirmed independently of that unknown.

## Findings

- Modrinth's current `.mrpack` format describes `downloads` as an array of HTTPS URLs where a file may be downloaded. It requires SHA-1 and SHA-512 hashes for each file. Its `fileSize` is mainly a progress-bar utility.
- Modrinth's API describes a version-file hash as computed from the file's byte content and exposes SHA-1/SHA-512 file hashes. A payload that does not match the manifest hash must remain rejected; a different source is acceptable only if its bytes match both expected hashes.
- Modrinth's format lists the provider hosts used by this project (`cdn.modrinth.com`, `github.com`, `raw.githubusercontent.com`, `gitlab.com`) and recommends following a reasonable number of validated redirects. The existing app already enforces those provider and redirect rules.

## Decision

- Preserve trusted candidate URLs in manifest order instead of discarding all but the first.
- Reuse the existing three-attempt per-file budget and rotate through candidates by attempt number. With one URL, behavior remains three retries of that URL. With several URLs, attempts use successive candidates before cycling back. This keeps the number of full transfers bounded by the existing limit.
- Keep each attempt in a fresh `.part` file and retain the current fail-closed SHA-1 and SHA-512 checks, transfer-size cap, redirect validation, cancellation, progress rollback, staging cleanup, and atomic publication behavior.
- Do not add dependencies or substitute a different file/version. If the bounded attempts do not produce bytes matching both hashes, fail the install.

## Sources

- Modrinth, [Modrinth Modpack Format (`.mrpack`)](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack) — `downloads`, required SHA-1/SHA-512, and `fileSize` semantics.
- Modrinth, [Get version from hash](https://docs.modrinth.com/api/operations/versionfromhash/) — file hashes are based on byte content and API file metadata.

## Evidence limitation

No selected `.mrpack` file, version ID, or install log was supplied with the screenshot. The change repairs the confirmed code defect in handling alternative URLs; it cannot prove that the screenshot's exact manifest has an alternate source or that a live CDN currently serves matching bytes.

## Post-implementation note (2026-10-09)

The parser now retains all trusted candidate URLs in manifest order, and the required-file retry sequence rotates through them within the existing three-attempt limit. The independent source review passed; the test and formatting limitations are recorded in `.workflow/artifacts/reviews/backend-009-modrinth-download-source-failover-review.md`.
