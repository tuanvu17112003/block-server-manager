# ADR-0013: Recognized Server Pack Formats and Server-Side Mod Selection

**Status:** Accepted and implemented. Supersedes conflicting import-detection details in ADR-0012 and the all-files server policy in ADR-0008. Its Java runtime selection and metadata-preflight policy is superseded by ADR-0014.  
**Date:** 2026-10-10

## Context

CurseForge does not define one universal server-pack ZIP layout. The supplied Craft to Exile archive is a complete Forge runtime, while the supplied Prominence II download is a ZIP wrapper around a ServerPackCreator Fabric pack that relies on first-run loader setup scripts. The current importer rejects Fabric and incorrectly reports valid Forge libraries missing because it interprets `-DignoreList` basenames as paths.

The current Modrinth importer ignores `env.server` and installs client-only files. The supplied Fabric log shows the resulting class of server failure: client-only code tries to load client lifecycle APIs on a dedicated server. Another supplied log shows a mod's exact Java 21 dependency failing under Java 25. Recommendation warnings are soft dependencies and are not missing required pack downloads.

## Decision

- Keep CurseForge input to ZIP. Recognize verified complete Forge/NeoForge runtime archives, recognized ServerPackCreator packs with supported loader metadata, and a single nested-ZIP wrapper around one of those formats. Provision a recognized metadata-only pack's base server runtime using the existing verified installer, then overlay archive files through the existing safe staging path.
- Do not execute pack-provided scripts. Do not resolve CurseForge client-export project/file references or call undocumented endpoints. Unknown or ambiguous layouts remain unsupported with a specific reason.
- Validate launch payload references from actual argument/classpath values. Ignore `-DignoreList` values because they are basename exclusions, not filesystem dependencies.
- For Modrinth dedicated servers, install `env.server=required` and `optional` entries; skip `unsupported` entries. Treat absent `env`/`server` fields as installable for backwards compatibility. Validate all manifest paths and integrity metadata, and report included/skipped counts.
- Do not recursively fetch Modrinth recommendation dependencies that are absent from the selected `.mrpack`. Preserve exact pack files, SHA-1/SHA-512 checks, URL allowlists, retries, overrides, cancellation, and atomic publication.
- Validate Fabric `depends.java` constraints found in installed server mod JARs before publication. Reject a runtime that does not satisfy a recognized constraint with an actionable Java-major message; do not silently rewrite a user's selected Java path.

## Consequences

- The supplied Forge false positive and the recognizable nested ServerPackCreator Fabric pack can be supported without script execution or CurseForge API access.
- Client-only files marked unsupported by the pack are no longer installed on the server. A pack that mislabels client-only code as server-compatible can still fail and must be corrected by its publisher.
- Optional Modrinth entries stay included by default, preserving the user's prior all-files preference where server metadata permits them. Missing recommended dependencies remain warnings.
- Java compatibility can be checked from Fabric metadata for supported Java-major predicates. Unknown constraint syntax remains a validation error or a clearly logged unverified condition; no arbitrary JRE is selected automatically.
- Adding a new archive loader requires exact provider verification and a representative fixture. This is not a claim that every arbitrary CurseForge ZIP can be installed.

## References

- [Research: server-pack formats and Modrinth startup failures](../../research/2026-10-10-server-pack-formats-and-modrinth-startup.md)
- [CurseForge import ADR-0012](0012-curseforge-server-pack-import.md)
- [Modrinth all-files ADR-0008](0008-install-all-modrinth-pack-files.md)

