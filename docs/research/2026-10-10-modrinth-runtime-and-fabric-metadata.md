# Modrinth Runtime Selection and Fabric Metadata Preflight

Date: 2026-10-10  
Status: Research complete; implementation pending.

## User-visible failures

Two Modrinth installs stop at 88%, while applying server overrides:

- A Fabric `cobblemon` diagnostic says Java 21 is required while Java 25 is selected.
- `better-end-4.0.11.jar` is rejected because the installer reports malformed `fabric.mod.json`.

The late progress position is consistent with the current sequence: pack downloads and large overrides happen before the Fabric metadata scan. Neither is an override failure; both are preflight checks that need to happen earlier.

## Local Better End evidence

The local audit found four byte-identical `better-end-4.0.11.jar` copies (92,544,800 bytes; SHA-256 `285FEEE4A2602AC66F7B4D92F0D972AC872AEC513C2B61A8F6F447CA3DC08420`). Each contains a `fabric.mod.json` with eight literal LF bytes inside the quoted `description` value. The metadata has no `depends.java` field.

Strict JSON parsing rejects an unescaped LF inside a quoted string. Fabric Loader's bundled Gson `JsonReader` does not reject the literal LF in `nextQuotedValue`, so this specific file is accepted by Fabric. Existing local server logs show Fabric Loader 0.19.3 loading Better End 4.0.11 and initializing its BCLib configuration. Later server failures are from a separate `colorwheel_patcher` client API issue; they do not indicate that Better End's metadata failed.

Conclusion: the scanner's use of a standards-strict JSON parser is incompatible with input Fabric itself accepts. This scan exists only to inspect Java dependency metadata. It must not reject an otherwise valid pack solely because it cannot parse metadata; when a field cannot be safely interpreted, report that the Java constraint could not be checked and continue without claiming compatibility.

The two exact `latest.log` paths supplied with the original report (`ddac40b3-9bc6-4132-bef0-f65ffb1682b3` and `06b1a81c-5daa-4486-a85d-9696ac561b82`) are absent from the current app-data tree, so their specific startup errors could not be verified. Separate existing server logs do confirm that Better End 4.0.11 loads successfully from the same JAR bytes.

## Fabric Java dependency semantics

Fabric's `fabric.mod.json` documentation and Loader implementation establish:

- `depends.java` is a hard dependency and can be one predicate string or an array of predicate strings.
- Array entries are alternatives (OR). Within a single predicate string, space-separated terms are conjunctive (AND).
- A bare version such as `21` is exact equality. `>=21` means Java 21 or later. Therefore Java 25 satisfies `>=21`, but not bare `21`.
- The loader uses its extended version-predicate parser. The installer must either implement the documented syntax it accepts or treat unsupported syntax as unverified; it must not incorrectly convert a minimum into exact equality or reject a pack with a false mismatch.

Minecraft's version-derived Java baseline and each mod's Java predicate are separate inputs. Selecting the first installed runtime above the Minecraft minimum is not enough: on Minecraft 1.21.1 it can choose Java 25 even when the expected runtime is Java 21. The configure flow already knows the version-specific recommended major and can prefer that exact installed major, otherwise request that major before installation. A user's explicit Java override remains a deliberate choice and is checked against discovered mod constraints.

## Modrinth archive/install semantics relevant to the scan

The `.mrpack` manifest identifies downloadable files and their integrity hashes; overrides are applied after file installation, with `server-overrides/` applied as the server-specific layer. Fabric constraints reside inside mod JARs, not in the `.mrpack` file list. Thus the accurate scan cannot run before those JARs have been made available. It should run after pack downloads but before copying potentially multi-gigabyte overrides, and it must inspect the effective final mod-JAR set, including JARs supplied or replaced by either override layer with server overrides taking precedence.

Only server-included Fabric mod JARs should affect the scan. Preserve the current `env.server` selection policy, hash/path checks, cancellation, and staged publication safeguards. Do not execute pack scripts.

## Current implementation trace

- The Create view currently auto-selects the first Java candidate returned by detection, which can be a newer installed runtime such as Java 25 even when `installMajor` is 21.
- The backend checks `depends.java` after applying Modrinth overrides, so a late incompatibility wastes the override copy work.
- The scanner parses `fabric.mod.json` with strict `serde_json` and accepts only a string constraint, while Fabric accepts a string or array and supports OR/AND predicate semantics.

## Sources

- [Fabric `fabric.mod.json` documentation](https://docs.fabricmc.net/develop/loader/fabric-mod-json)
- [Fabric Loader metadata dependency parser](https://raw.githubusercontent.com/FabricMC/fabric-loader/master/src/main/java/net/fabricmc/loader/impl/metadata/V1ModMetadataParser.java)
- [Fabric Loader dependency matching](https://raw.githubusercontent.com/FabricMC/fabric-loader/master/src/main/java/net/fabricmc/loader/impl/metadata/ModDependencyImpl.java)
- [Fabric Loader version predicate parser](https://raw.githubusercontent.com/FabricMC/fabric-loader/master/src/main/java/net/fabricmc/loader/impl/util/version/VersionPredicateParser.java)
- [Fabric Loader bundled Gson JSON reader](https://raw.githubusercontent.com/FabricMC/fabric-loader/master/src/main/java/net/fabricmc/loader/impl/lib/gson/JsonReader.java)
- [Modrinth `.mrpack` format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack)
