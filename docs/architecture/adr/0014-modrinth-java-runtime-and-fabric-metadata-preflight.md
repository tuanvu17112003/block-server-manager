# ADR-0014: Modrinth Java Runtime and Fabric Metadata Preflight

**Status:** Accepted and implemented; supersedes ADR-0013's Java compatibility policy  
**Date:** 2026-10-10

## Context

ADR-0013 introduced a Java compatibility scan for Fabric server mods. Follow-up installs exposed two defects in that implementation: it may auto-select Java 25 for a Minecraft version whose recommended runtime is Java 21, and it parses each `fabric.mod.json` as strict JSON even though Fabric Loader accepts some non-standard metadata, including the local Better End file's literal line feeds inside a string. The scan also runs after server overrides, causing avoidable late failures.

Fabric's actual `depends.java` semantics are richer than an exact major comparison: one string or an array of strings, OR across array entries, AND across space-separated predicates, exact equality for bare versions, and explicit operators such as `>=` for ranges.

## Decision

- Keep Minecraft's version-derived recommended Java major distinct from mod-declared Java predicates. For the automatic Create choice, select the installed candidate matching the recommended major; if absent, require/propose installing that major instead of silently choosing a newer candidate. A deliberate user override remains explicit.
- Check constraints for the effective set of selected server-included Fabric mods after pack downloads and before the expensive override copy. Include mod JARs supplied or replaced by `overrides/` and `server-overrides/` in that preflight. Preserve override precedence, staged installation, and publication checks.
- Parse Fabric metadata with behavior compatible with syntax Fabric Loader accepts for the fields being inspected. Support `depends.java` as a string or array, OR across array elements, AND within a string, exact bare versions, and supported operators/ranges.
- This is a bounded compatibility scan, not full Fabric metadata validation. If metadata is malformed, uses unsupported predicate syntax, or asks for Java minor/patch precision that the currently detected major-only runtime data cannot compare, report a per-mod unverified warning and continue; do not truncate the predicate or fabricate either a mismatch or a guarantee of compatibility. A positively identified unmet hard Java dependency remains a blocking, actionable error.
- Check cancellation between inspected JARs. Temporary override-JAR scratch content must be removed before a successful preflight return; cleanup failure blocks publication.
- Preserve ADR-0013's server-file filtering, integrity validation, explicit Java override, no-script-execution, and publish-after-validation policies.

## Consequences

- Minecraft 1.21.1 pack setup no longer silently begins with Java 25 when the expected runtime is Java 21.
- A Java 25 runtime correctly satisfies `>=21`, while failing a bare exact `21` constraint.
- Better End metadata accepted by Fabric no longer causes a false install rejection solely due to the scanner's strict JSON parser.
- A genuine discovered conflict is reported before expensive overrides are copied. Unknown metadata remains visible as unverified rather than being mistaken for success or a definite incompatibility.

## References

- [Fabric `fabric.mod.json` and dependency syntax](https://docs.fabricmc.net/develop/loader/fabric-mod-json)
- [Fabric Loader metadata parser](https://raw.githubusercontent.com/FabricMC/fabric-loader/master/src/main/java/net/fabricmc/loader/impl/metadata/V1ModMetadataParser.java)
- [Fabric Loader predicate matching](https://raw.githubusercontent.com/FabricMC/fabric-loader/master/src/main/java/net/fabricmc/loader/impl/metadata/ModDependencyImpl.java)
- [Fabric Loader version predicates](https://raw.githubusercontent.com/FabricMC/fabric-loader/master/src/main/java/net/fabricmc/loader/impl/util/version/VersionPredicateParser.java)
- [Modrinth `.mrpack` format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack)
- [Research note](../../research/2026-10-10-modrinth-runtime-and-fabric-metadata.md)
