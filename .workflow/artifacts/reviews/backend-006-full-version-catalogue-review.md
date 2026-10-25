# Full Version Catalogue — Independent Review (final)

Date: 2026-10-09
Task: backend-006-full-version-catalogue
Scope: `src-tauri/src/installer/mod.rs`, `src/tabs/Create.tsx`, `src/tauri.ts` + narrow `forge_build_version` in `src-tauri/src/servers/process.rs`.

## Result

**PASS** after one scoped rework (attempt 1 of 3).

## First review: FAIL

- Blocker: Forge `specific:` installs validated/downloaded but could not resolve a launch mode or Start (`process.rs::forge_build_version` rejected non-promotion labels).
- Majors: promotion/suffix false-reject risk for legacy MCs; 3 test-coverage overclaims (Paper envelope, `validate_fabric_loader`, ordering/labels).
- Minors: Paper empty-channel label, catalogue hygiene note, stale step-1 copy, Modrinth snapshot scope bleed.

## Rework (user-approved scope: narrow `process.rs` fix; packs revert to releases-only)

1. `forge_build_version` accepts `specific:<artifact>` (safe chars + `{mc}-` prefix), returns the full versioned segment; both callers use it directly — choice → install → launch → Start traced end to end.
2. `resolve_forge_promotion_artifact`: exact match wins, else single-suffix match, else fail closed (regression test with `-mc172` fixture).
3. Genuine tests: Paper envelope via real `parse_paper_builds_value`; shared `fabric_loader_version_matches` for both Fabric validators; ordering/label helper tests.
4. Empty-channel Paper builds labelled non-stable. 5. Step-1 copy updated. 6. Pack flow releases-only on both sides; standalone snapshots intact; backend-005 exact path intact.

## Final re-review: PASS

- All 6 claims verified against real code paths; all callers migrated; scope held (no catalogue fetch in `process.rs`, NeoForge tables in sync, no command changes, additive DTO field only).
- Residual: none blocking/major/minor on code. One docs-only observation (B11 marker wording) resolved by PQM labelling step 11.
