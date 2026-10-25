# Implementation Guide — Modrinth Root-Level Overrides (backend-012)

Read first: [`../research/2026-10-09-modrinth-root-level-overrides.md`](../research/2026-10-09-modrinth-root-level-overrides.md), [`../specs/modrinth-overrides.md`](../specs/modrinth-overrides.md), and [`../specs/modpack-installation.md`](../specs/modpack-installation.md) §Installation.

## Scope and constraints

- Owned path: `src-tauri/src/modpacks/install.rs`.
- Let a validated one-component override file path target the staging root without trying to create an empty parent directory.
- Keep nested parent-directory creation and all existing archive/path/reparse/reserved-path protections intact.
- Add focused regression coverage for root-level and nested destination parents.
- Do not change layer order, client override policy, download logic, or dependencies.

## Ordered steps

1. Adjust override parent-directory preparation so it is conditional on a nonempty parent path.
2. Add regression coverage for a root-level file and a nested file.
3. Run the focused Rust module tests, Rust formatting check, and relevant compile check.

## Checklist

- [x] Root-level shared and server files can be written under staging.
- [x] Nested files still create their directories.
- [x] Existing path safety and conflict checks remain before writes.
- [x] `cargo fmt --check`, `cargo test --lib --offline`, and `cargo check --lib --offline` pass.

## Live verification

- Built and launched the desktop app, selected Prominence II: Hasturian Era version 4.0.5 (`iqWrFu7S`, Minecraft 1.20.1, Fabric), and confirmed the user-accepted EULA checkbox.
- The Modrinth install reached 100% / Done after applying server overrides; the app reported the pack installed and saved. The `Modrinth override has no destination parent` error did not recur.
- The test server was left stopped. UI verification details: `.workflow/artifacts/test-logs/backend-012-modrinth-override-ui-verification.md`.
