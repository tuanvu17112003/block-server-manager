# Specification — Server Pack Import and Modrinth Server Compatibility

> Migration note (2026-10-11): this records the existing implementation's behavior. The target contract for the full replacement pipeline is [`modpack-server-setup-overhaul.md`](modpack-server-setup-overhaul.md).

## Goal

Create a valid managed server from recognizable CurseForge server ZIP layouts and install a Modrinth pack's server-compatible files with the runtime constraints needed to avoid known startup failures.

## Status and verification

Implemented and independently reviewed. Current Rust unit tests pass (111/111), `cargo fmt -- --check` passes, `cargo build --lib` passes, and `npm run build` passes. No live server was started and no pack script was executed.

## Supported archive layouts

- Complete Forge/NeoForge server ZIP with a validated exact loader build and launch argument files.
- Recognized ServerPackCreator ZIP with Minecraft and supported loader versions; provision its base runtime using the official existing installer.
- One outer ZIP containing exactly one inner server ZIP of either supported form.
- CurseForge client-export ZIPs remain identified as client exports and unsupported because they require gated CurseForge file resolution.
- Other loaders or ambiguous ZIPs remain unsupported until exact metadata and a representative fixture exist.

Scripts are preserved as pack files but never executed. Paths, reparse points, duplicate destinations, archive size, expanded size, free space, reserved manager paths, and cancellation remain validated.

## Modrinth server file policy

- `env.server=required`: install after existing path, URL, size, SHA-1, SHA-512, cancellation, and staging checks.
- `env.server=optional`: include by default, matching the existing user preference to include pack-listed files.
- `env.server=unsupported`: skip for dedicated-server installation and include the skipped count in the install log.
- Missing `env` or missing `env.server`: install for backwards compatibility.
- Invalid environment values fail manifest validation. All paths are validated before policy selection.
- Never recursively fetch absent Modrinth `recommends` entries. The selected `.mrpack` remains the source of the pack's files.
- Keep shared `overrides/` followed by `server-overrides/`; ignore `client-overrides/`.

## Runtime compatibility

- Keep Minecraft's recommended Java major separate from mod requirements. Automatic Create selection prefers the exact recommended major; if it is not installed, direct the user to install/select it before starting the pack setup instead of silently selecting a newer installed Java.
- Preserve an explicit user-selected Java override. Inspect the effective set of server-included Fabric JARs after pack download but before the potentially large Modrinth override copy, including JARs supplied/replaced by `overrides/` and `server-overrides/`.
- Match Fabric `depends.java`: string or array; array alternatives are OR; whitespace-separated terms in a string are AND; bare versions are exact; explicit operators express ranges. Thus Java 25 satisfies `>=21` but not exact `21`.
- A positively detected unmet hard requirement blocks publication with mod ID, range, selected major, and an actionable runtime instruction. An unreadable or unsupported metadata/predicate form is logged as unverified and does not become a fabricated mismatch; this scanner does not certify full mod compatibility.
- If a predicate depends on Java minor/patch precision that the runtime detector does not expose, report it as unverified rather than comparing only the leading major. Check cancellation between JARs and remove preflight scratch content before publication.
- For missing mod dependencies, inspect the effective server Fabric mod set before override copying. Block publication when a server-active mod's hard `depends` ID has no active provider in the payload, after accounting for Fabric built-ins, `provides` aliases, and declared nested JARs. Client-only providers do not satisfy server dependencies.
- Keep Modrinth `env.server=unsupported` exclusions and do not automatically fetch missing `depends` or `recommends` files. A definite missing hard dependency reports the dependent mod and missing ID; unparseable/bounded-out metadata is called out as an incomplete check. This is not a full Fabric version-range or code-execution validator.
- Bound total central-directory and nested-path inspection work. A final incomplete dependency scan must be surfaced as incomplete, not a generic runtime-validation success.
- The current ZIP library collapses duplicate raw central-directory names; this checker does not claim to validate that malformed-archive case. It does detect repeated declared nested-JAR paths and missing declared nested entries.
- Parse metadata compatibly with Fabric Loader for the inspected fields. In particular, a literal newline in a quoted description, accepted by Fabric's bundled reader and present in the local Better End JAR, must not itself block installation.
- Do not treat Fabric `recommends`, `suggests`, or `conflicts` warnings as required download failures.
- Pack metadata can be wrong. If a mod is marked server-compatible but executes client-only classes, the installer cannot safely transform the mod; it reports the provider/pack incompatibility.

## CurseForge archive behavior

- Inspect recognizes a complete archive or the supported single nested-ZIP shape and reports Minecraft/loader/build before Configure.
- A Forge `-DignoreList` is not a filesystem classpath. Only actual launch paths are checked against normalized archive entries.
- ServerPackCreator metadata must contain a valid Minecraft version, a supported loader/version, and a nonempty server-pack inventory; the manager installs the matching official base runtime and overlays safe pack files.
- The same detected format, versions, and paths are revalidated at install time before publication.

## Acceptance criteria

- [x] Craft to Exile 2's exact `win_args.txt` references validate; the comma-separated ignore list does not produce false missing-JAR errors.
- [x] A single nested ZIP containing a recognized ServerPackCreator Fabric pack inspects as supported and its manager-created runtime is validated without running pack scripts.
- [x] Direct complete Forge/NeoForge imports retain the packaged runtime and existing atomic publication behavior.
- [x] Modrinth required/optional files install, unsupported server files skip, absent environment metadata stays compatible, and invalid values fail clearly.
- [x] The installed-file set and log accurately report included/skipped entries; missing recommendations are not silently fetched.
- [x] Fabric Java constraints that do not match the selected runtime prevent publication with an actionable message.
- [x] Automatic Modrinth setup uses the Minecraft-recommended Java major; Fabric predicates use exact/range and array OR semantics; the bounded scan runs before large overrides, checks effective override JARs, honors cancellation/cleanup, and tolerates metadata syntax Fabric accepts.
- [x] Modrinth Fabric hard dependencies are checked against the effective dedicated-server mod set before overrides/publication, so missing required IDs block publication without installing server-unsupported files.
- [x] Existing path, URL, hash, size, cancellation, EULA, staging, publication, and Start-path safeguards remain in force.
- [x] User-provided scripts are never executed.

## Related documents

- [Research findings](../research/2026-10-10-server-pack-formats-and-modrinth-startup.md)
- [ADR-0013](../architecture/adr/0013-server-pack-format-and-server-mod-policy.md)
- [ADR-0014](../architecture/adr/0014-modrinth-java-runtime-and-fabric-metadata-preflight.md)
- [ADR-0015](../architecture/adr/0015-block-modrinth-packs-with-missing-server-dependencies.md)
- [Implementation checklist](../implementation/server-pack-correctness.md)
- [Runtime/metadata checklist](../implementation/modrinth-runtime-and-fabric-metadata.md)
- [Missing hard dependencies checklist](../implementation/modrinth-missing-hard-dependencies.md)

