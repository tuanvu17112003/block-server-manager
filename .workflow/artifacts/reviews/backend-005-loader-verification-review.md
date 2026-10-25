# Loader Verification Follow-up — Independent Review

Date: 2026-10-09
Task: backend-005-loader-verification
Scope: `src-tauri/src/installer/mod.rs` — Modrinth Fabric exact-build downstream gates.

## Result

**PASS** — independent reviewer, no blockers.

## What was reviewed

- New `is_modpack_fabric_exact` predicate (`loader == "Fabric"` + `modpack_id` starts with `modrinth:`) branching three sites to `verify_modpack_fabric_build` exact endpoint:
  - `resolve_install_artifact` Fabric branch (covers `base_server_reserve`),
  - `prepare_install_with_progress` revalidation,
  - `prepare_modpack_install` pre-publication revalidation.
- `resolve_modpack_loader_version` Fabric exact path (pre-existing) unchanged.
- Standalone stable-only preserved: `resolve_loader_choices` filter, `validate_fabric_loader`, `loaders_resolve` untouched; `server_install` rejects `modpack_id`, so the predicate cannot be true standalone.
- Fail-closed on wrong/missing/malformed metadata; no version substitution; errors stay `AppError::Validation` with no secret/path leakage.
- Unit tests genuinely cover: exact match with `stable: false` passes, wrong version fails, missing version fails, predicate routing (modpack true / standalone + Forge false). Reviewer ran safety subset 7/7.

## Minor non-blocking notes (no rework required)

- Predicate test could add Vanilla/Paper/NeoForge, wrong-prefix, and case negatives.
- Missing-version tests could add a non-string-type malformed case (`version: 123`, `loader: null`) — implementation already fail-closes via `as_str → None`.
- Exact metadata check asserts `loader.version` only, not `intermediary.version == mc` — low risk, not required by spec.
- Predicate name slightly broad when `loader_version` is `None`, but all call sites fail-closed on `None`.

## Scope check

- `grep` for the new symbols hits only `src-tauri/src/installer/mod.rs` (+ state mention). `Cargo.toml` still only `zip = "=2.4.2"`; no new commands in `lib.rs`; no CurseForge/API-key or frontend changes. (`git diff` unavailable — `master` has no commits, all paths untracked.)
