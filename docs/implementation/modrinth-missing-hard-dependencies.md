# Implementation — Modrinth Missing Hard Dependencies

## Owned paths

- `src-tauri/src/modpacks/install.rs` — bounded Fabric candidate scan, dependency metadata, effective pack/override set, and focused tests.
- `src-tauri/src/installer/mod.rs` — call the missing-dependency check after downloads and before bulk overrides; retain final post-copy validation.
- `docs/specs/server-pack-install-correctness.md`, ADR-0015, research/index files, and `WORKFLOW_STATE.md`.
- No UI changes or dependency additions unless a concrete error-display issue requires them; no runtime server launch.

## Ordered work

1. Reuse the bounded metadata reader and raw-control normalization from the Java preflight. Parse only metadata declared in root `fabric.mod.json` and nested JARs explicitly listed by `jars`.
2. Collect IDs, `provides`, server environment, hard `depends` IDs, and declared nested-JAR paths from direct `mods/*.jar` candidates. Apply JAR byte, aggregate central-directory-entry, metadata-byte, recursion-depth, declaration-lookup, scratch-byte, and total nested-candidate limits. Build any nested-entry name index once per archive; do not rescan the central directory per declared path.
3. Construct the effective pre-override server candidate set: included downloaded mods excluding replaced paths plus effective shared/server override JARs. Preserve shared then server precedence. Do not include `env.server=unsupported` files or client overrides.
4. Resolve presence of hard dependency IDs against active server candidates, aliases, nested mods, and actual built-ins (`minecraft`, `fabricloader`, `java`). Exclude `environment=client`; default missing environment to `*`. Keep recommends/suggests non-blocking.
5. On a definite missing ID, return an actionable validation error naming dependent JAR/mod and missing ID before copying large overrides or publishing. When possible, include the matching skipped `env.server=unsupported` path. Never fetch by mod ID or silently remove dependent entries.
6. Log unverified metadata/bounds as incomplete rather than falsely declaring the pack compatible. Final progress/log text must reflect an incomplete dependency scan and must not say all runtime validation passed. Do not claim full range resolution or execute any mod code.
7. Add focused regressions for missing required IDs (`modmenu`, `s_lib`, `simplytooltips`), satisfied built-ins, `provides`, a declared nested provider, client-only provider exclusion, optional/recommendation omission, shared/server replacement, and no publication after a definite conflict.

## Acceptance checklist

- [x] The supplied server log's hard missing dependencies are discovered from installed Fabric metadata before override copying.
- [x] Client-only and `env.server=unsupported` JARs remain excluded; the error explains the dependent mods and missing IDs.
- [x] The effective server mod set honors shared and server override precedence, declared nested JARs, `provides`, and Fabric built-ins.
- [x] Soft `recommends`/`suggests` omissions do not block; no new downloads are made for absent dependency IDs.
- [x] Malformed/unbounded metadata is reported as an incomplete check without false certainty; every scan remains bounded/cancellable.
- [x] Repeated paths in Fabric `jars` metadata and missing declared nested paths mark the scan incomplete.
- [x] Existing Java checks and Modrinth integrity, path, cancellation, EULA, staging, publication, and no-script behavior remain intact.
- [x] Independent review passes; Rust regression tests (111/111), formatting, library build, and frontend build pass.

## Known archive-inspection limitation

The installed `zip` 2.4.2 API materializes central-directory entries into a name-keyed `IndexMap`; duplicate raw central-directory names are collapsed before `len()`, `file_names()`, or indexed access can expose them. This preflight therefore does not claim to detect duplicate raw central-directory records. It does mark repeated paths in Fabric's declared `jars` metadata and missing declared archive paths as incomplete. Supporting raw central-directory duplicate detection would require a parser-level change beyond this checklist.

## References

- [Specification](../specs/server-pack-install-correctness.md)
- [ADR-0015](../architecture/adr/0015-block-modrinth-packs-with-missing-server-dependencies.md)
- [Research](../research/2026-10-10-modrinth-missing-hard-dependencies.md)
