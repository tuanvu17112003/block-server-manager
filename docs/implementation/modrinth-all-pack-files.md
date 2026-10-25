# Implementation Guide — Install All Modrinth Pack Files (backend-014)

Read first: [`../research/2026-10-09-modrinth-all-pack-files.md`](../research/2026-10-09-modrinth-all-pack-files.md), [`../specs/modrinth-all-pack-files.md`](../specs/modrinth-all-pack-files.md), [`../specs/modpack-installation.md`](../specs/modpack-installation.md), and [ADR-0008](../architecture/adr/0008-install-all-modrinth-pack-files.md).

## Scope and constraints

- Owned paths: `src-tauri/src/modpacks/install.rs`, `src-tauri/src/installer/mod.rs`, `src/tabs/Create.tsx`, and the linked docs.
- Include all manifest file entries regardless of environment labels; preserve exact file paths, downloads, sizes, and hashes.
- Do not weaken path, reserved-path, URL, redirect, size/hash, concurrency, cancellation, staging, rollback, or explicit EULA protections.
- Keep existing override layer order and the disabled CurseForge integration.

## Ordered steps

1. Remove environment-based skip branches from manifest planning and produce a pack file list containing every validated `files[]` entry.
2. Remove obsolete skip counters/log text and update the Tauri Configure parity notice to match the new all-files behavior.
3. Replace the parser regression test with coverage asserting inclusion of required, optional, unsupported, client-only, and missing-environment entries; keep hash/URL/path rejection tests.
4. Run Rust formatting, the full Rust library suite, and the library compile check. Review the diff independently.

## Checklist

- [x] Every manifest file is included, irrespective of `env`.
- [x] Existing validation and transfer integrity safeguards remain in force.
- [x] UI and logs accurately say all manifest files are included.
- [x] Rust tests, formatter, compile check, and independent review pass.

## Verification

- `cargo fmt --check`: PASS.
- `cargo test --lib --offline`: PASS, 54 tests.
- `cargo check --lib --offline`: PASS, with two existing dead-code warnings.
- `cargo build --bin mc-server-manager --offline`: PASS.
- `npx tsc --noEmit`: PASS.
- Independent review: PASS after one wording-only rework.
