# ADR-0015: Block Modrinth Packs with Missing Server Dependencies

**Status:** Accepted and implemented  
**Date:** 2026-10-10

## Context

A Modrinth install published a Minecraft 1.20.1 Fabric server with 352 pack files included and 211 entries marked `env.server=unsupported` skipped. Fabric Loader then aborted because included server-visible mods declared hard dependencies on `modmenu`, `s_lib`, and `simplytooltips`, all absent from the installed mod set.

The exact pack audit found that Mod Menu and Simply Tooltips are client-only and correctly excluded by the pack's server flags. S-Lib's exact version is server-capable at Modrinth, but the pack marks it unsupported. Automatically installing unsupported files would ignore the `.mrpack` contract and can place client-only code on a dedicated server. The installer currently checks Java compatibility but not the presence of required Fabric mod IDs before publishing.

## Decision

- Preserve Modrinth's `env.server` policy: install required/optional entries per the existing product choice; skip unsupported entries; do not recursively fetch absent recommendations or silently override an unsupported flag.
- Before bulk overrides and before publication, statically inspect the effective server mod set for definitely missing Fabric hard dependency IDs.
- Build the candidate set only from Fabric mods active on a dedicated server. Include `provides` aliases, declared nested JAR candidates, and actual Fabric built-ins. Exclude `environment=client` candidates. Preserve effective override replacement order.
- A definite hard dependency with no active provider blocks publication with the dependent mod ID and missing dependency ID. If a matching file was skipped by the pack as server-unsupported, mention that context when known. Do not silently remove the dependent mod or download a replacement by Fabric mod ID.
- Keep `recommends`/`suggests` as non-blocking. Treat unparseable or bounded-out metadata as an explicit incomplete check; this preflight is not a full Fabric resolver or code-execution test.
- Bound aggregate central-directory traversal and declared nested-path lookups. An incomplete final scan must remain visibly incomplete in the installer stage/log and must not be reported as a full runtime-validation pass.
- The resolved ZIP library collapses duplicate raw central-directory names; this checker does not claim to detect that malformed-archive case. Repeated `fabric.mod.json` nested-JAR declarations and missing declared entries are detected as incomplete.
- Preserve existing Java runtime checks, hashes, paths, retries, cancellation, EULA, staging, final override application, and atomic publication.

## Consequences

- A manifest with internally inconsistent dedicated-server dependencies fails during install with a useful explanation instead of publishing a server guaranteed to fail at Fabric's dependency resolution.
- Correctly marked client-only files remain excluded. A pack or mod author must fix contradictory environment/dependency metadata, or the user must choose a curated different server mod set.
- This check detects definite missing provider IDs; it does not replace Fabric's full version-range solver or validate code paths. Version mismatches and client-only entrypoint failures can still be reported by Fabric at startup.
- No new dependency is needed, and the installer never executes mod or pack code to test compatibility.
- Duplicate raw central-directory records remain a known gap because the current `zip` 2.4.2 public API exposes a name-keyed index.

## References

- [Research note](../../research/2026-10-10-modrinth-missing-hard-dependencies.md)
- [ADR-0013: server-side Modrinth file selection](0013-server-pack-format-and-server-mod-policy.md)
- [ADR-0014: Java runtime and metadata preflight](0014-modrinth-java-runtime-and-fabric-metadata-preflight.md)
