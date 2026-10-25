# Implementation Guide — CurseForge Inspect ZIP Unicode Path Fix

Read first:

- [`../research/2026-10-10-curseforge-inspect-unicode-path.md`](../research/2026-10-10-curseforge-inspect-unicode-path.md)
- [`../research/2026-10-10-curseforge-embedded-download-handoff.md`](../research/2026-10-10-curseforge-embedded-download-handoff.md)
- [`../specs/curseforge-server-pack-import.md`](../specs/curseforge-server-pack-import.md) §Archive safety and limits
- [`curseforge-server-pack-import.md`](curseforge-server-pack-import.md) (follow-up note style)

## Owned paths

- `src-tauri/src/modpacks/curseforge_import.rs:117-138` — staged-ZIP listing/selection context.
- `src-tauri/src/modpacks/curseforge_import.rs:317-337` — `inspect_staged_zip` preflight including the `:327` `free_disk_space` call site.
- `src-tauri/src/modpacks/curseforge_import.rs:1661-1671` — `.part` progress observer, second latent file-path caller at `:1669`.
- `src-tauri/src/java/mod.rs:933-994` — `free_disk_space` and the `GetDiskFreeSpaceExW` wrapper at `:955-989`.
- `src-tauri/src/installer/mod.rs:1636-1644` + callers — existing directory-passing free-space callers (reference pattern; do not change).
- Tests: existing `free_disk_space` / `curseforge_import` unit tests alongside the new regression tests below.

## Ordered steps

1. Fix the `:327` call site: resolve the staged file's containing directory via `parent()` before calling `free_disk_space`; handle a missing parent by failing closed with the existing inspect-error shape.
2. Fix or guard the `:1669` `.part` observer the same way (directory resolution at the call site, or central normalization inside `free_disk_space` so both sites are covered).
3. Optionally harden `free_disk_space` (`java/mod.rs:933-994`) to normalize a file path to its parent directory, keeping directory inputs behaving exactly as before.
4. Add focused regression tests with small synthetic `™` (U+2122) fixtures: a staged file path with `™` in the leaf resolves to its parent for the Win32 call; ASCII file and directory inputs behave unchanged. Never use the real 1.1 GB `Prominence™_II` pack in tests.

## Constraints

- No logic, limit, or accounting changes: keep free-space arithmetic, headroom, and §Archive safety and limits thresholds unchanged.
- ASCII behavior unchanged; only the file-vs-directory argument kind changes.
- Inspect error message format stays stable (same `could not check free disk space ...` shape including the os-error suffix).
- Docs-only scope boundary for the follow-up worker: no dependency, API, staging-layout, or spec-matrix changes.

## Verification checklist

- [ ] Inspect on a synthetic `™`-leaf staged ZIP path no longer returns os error 267.
- [ ] `.part` observer path with `™` leaf resolves to its directory.
- [ ] ASCII staged paths and existing directory callers behave as before.
- [ ] New regression tests pass; existing `free_disk_space` / `curseforge_import` tests still pass.
- [ ] `cargo check`, library tests, and Rust formatting pass; error message format unchanged.
