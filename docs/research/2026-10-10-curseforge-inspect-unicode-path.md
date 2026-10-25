# Research — CurseForge Inspect ZIP Unicode Path Failure

**Date:** 2026-10-10  
**Related:** [Embedded download handoff](2026-10-10-curseforge-embedded-download-handoff.md), [Server-pack import research](2026-10-10-curseforge-server-pack-import.md), [`../../specs/curseforge-server-pack-import.md`](../../specs/curseforge-server-pack-import.md) §Archive safety and limits, [`../../implementation/curseforge-server-pack-import.md`](../../implementation/curseforge-server-pack-import.md)

## User evidence

- Staged file: `Prominence™_II_Hasturian_Era_v.4.1.3_server_pack cf.zip` where `™` = U+2122.
- Inspect ZIP on that staged file fails with: `could not check free disk space ... (os error 267)`.
- Screenshot facts (per Explorer handoff): the failure occurs at Inspect/archive-preflight time on the staged pack; all other preflights pass on this file.

## Code-path finding

- `inspect_staged_zip` (`src-tauri/src/modpacks/curseforge_import.rs:327`) passes the staged **file** path to `crate::java::free_disk_space`.
- `free_disk_space` calls Win32 `GetDiskFreeSpaceExW` (`src-tauri/src/java/mod.rs:955-989`), whose parameter is a **directory** name.
- Passing a file leaf where a directory is expected forces exact wide-string directory validation; with the `™` leaf this surfaces as `ERROR_DIRECTORY 267` (os error 267).
- All other preflights pass directories, so only this call site hits the file-vs-directory mismatch on a Unicode leaf.
- Second latent file-path caller at `curseforge_import.rs:1669` (`.part` progress observer) has the same shape and needs the same directory-resolution treatment.

## Why Rust-side encoding is ruled out

- `™` (U+2122) is a valid Unicode scalar, representable in Rust `String`/UTF-8 and in Windows UTF-16 wide strings; there is no lossy-conversion or mojibake step in this path per the Explorer finding.
- The observed error is `ERROR_DIRECTORY 267` from Win32 directory validation of a file path, not a Rust encoding/panic or replacement-character failure. Fixing the argument kind (directory, not file) addresses it; no string-encoding change is indicated.

## Fix guidance

- Resolve the containing directory before the Win32 call: apply call-site `parent()` at `curseforge_import.rs:327` (and audit `:1669`), and/or harden `free_disk_space` (`java/mod.rs:955-989`) to normalize a file path to its parent directory.
- Accounting and limits unchanged: keep the existing free-space arithmetic, headroom, and spec limits from §Archive safety and limits (2 GiB compressed, 100,000 entries, 20 GiB expanded, plus 512 MiB headroom) as-is.

## Open risks

- Only the two named call sites are confirmed; other future `free_disk_space` callers could repeat the file-path mistake if the hardening is call-site-only rather than inside `free_disk_space`.
- No live Windows retest against the real 1.1 GB pack is expected; regression must use small synthetic `™` fixtures instead.
- **No ADR needed — this is a bug fix with no new architectural choice.** No API, dependency, staging-layout, or policy decision changes.
