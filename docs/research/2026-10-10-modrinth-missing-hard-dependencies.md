# Modrinth Server Install: Missing Fabric Hard Dependencies

Date: 2026-10-10  
Status: Research complete; implementation pending.

## Exact failed-server evidence

The user supplied `C:\Users\tronv\AppData\Roaming\com.blockserver.manager\servers\cca13e07-b05f-48ce-8587-d94df1c711cf\logs\latest.log`. It starts Minecraft 1.20.1 with Fabric Loader 0.19.3, then aborts during Fabric mod resolution. The hard missing dependencies are:

- `forgeconfigscreens` 8.0.2 → `modmenu`
- `mutant_skeleton_armor_tweaks` → `s_lib` >=3.0.1+1.20.1
- `quests_teams_fixes` → `s_lib` >=2.1.0+1.20.1
- `simply_swords_tweaks` → `s_lib` >=3.0.1+1.20.1
- `simplyswords` and `simplybows` → `simplytooltips`
- `unrestricted_enchanting` → `s_lib` >=3.0.1+1.20.1

The matching `installer.log` says: `Modrinth server files: 352 included; 211 unsupported skipped.` The installed `mods/` directory has 349 JARs and contains the dependent mods above, but no JAR for `modmenu`, `s_lib`, or `simplytooltips`. These are missing-file failures, not hash/retry failures.

The included local JAR metadata was read without loading mod code. For example, `ForgeConfigScreens-v8.0.2-1.20.1-Fabric.jar` declares `depends.modmenu`; Simply Swords and Simply Bows declare `depends.simplytooltips`; several other included mods declare `depends.s_lib`.

The 352 included + 211 skipped count and exact missing dependency set match the prior bounded manifest audit for Prominence II 4.1.2 and 4.1.3. The server log does not persist a pack version ID, so this match is strong evidence rather than proof of the selected version.

## Pack/provider metadata conflict

The audited 4.1.2 and 4.1.3 `modrinth.index.json` files mark these entries `env.server=unsupported`:

| Skipped pack file | Provider environment | Included dependent |
|---|---|---|
| `modmenu-7.2.2.jar` | Client-side only | Forge Config Screens |
| `SimplyTooltips-fabric-0.1.5-1.20.1.jar` | Client-side only | Simply Swords, Simply Bows |
| `s-lib-fabric-3.0.1+1.20.1.jar` | Client and server | Mutant Skeleton Armor Tweaks, Quests & Teams Fixes, Simply Swords Tweaks, Unrestricted Enchanting |

The pack's `env.server` flags for Mod Menu and Simply Tooltips align with their official client-only classification. Installing those two entries on a dedicated server is not a safe fix. S-Lib's exact 3.0.1+1.20.1 version is server-capable according to Modrinth, but the pack explicitly marks its file unsupported. A launcher must not silently override that pack-level server exclusion.

## Why Fabric fails after installation

Modrinth's `.mrpack` format defines `env.server=unsupported` as a file that cannot be installed server-side. The current manager follows that rule, omitting these entries while retaining the pack's other files.

Fabric Loader 0.19.3 can soften some schema-v1 hard dependencies for mods disabled by environment only when it discovered a matching disabled candidate. The exact code checks `envDisabledMods` for the missing ID and matching version before changing a dependency to `SUGGESTS`. An omitted JAR is not an environment-disabled candidate; Loader cannot know it was skipped by the pack installer, so the hard dependency remains unresolved and server startup fails.

Fabric's metadata docs confirm that a missing `depends` entry causes Loader to crash, that `environment=client` mods are not loaded on dedicated servers, that `provides` creates aliases, that declared nested JARs are mod candidates, and that missing `recommends` entries only warn. Therefore including every unsupported file would put two client-only mods into the server and still would not be a correct general fix.

## Current code gap and safe behavior

The manager filters the `.mrpack` file list by server environment, verifies/downloads included entries, and validates Java requirements. It does not compare included Fabric hard dependencies with the effective server mod set before publication. Thus it publishes a pack that Fabric immediately rejects.

The safe correction is a bounded static dependency preflight before bulk overrides and before publication:

1. Build the final server-visible Fabric candidate set from included `mods/*.jar` files plus effective `mods/*.jar` overrides, honoring shared then server override precedence.
2. Recognize only Fabric Loader candidates: skip `environment=client` on a dedicated server; default omitted `environment` to `*`; include `environment=server` and `*`.
3. Account for `provides` aliases and recursively declared nested JARs, with the existing JAR/metadata bounds plus explicit recursion and total-candidate limits. Do not inspect arbitrary undeclared embedded ZIP/JAR entries.
4. Compare hard `depends` IDs against server-active candidates and Fabric built-ins (`minecraft`, `fabricloader`, `java`). Ignore `recommends`, `suggests`, and conflicts for this missing-hard-dependency check. A client-only provider does not satisfy a dedicated-server dependency.
5. If metadata is readable and a hard provider is definitely absent, stop installation before override copying/publication and name each dependent mod and missing ID. Include skipped unsupported-file context when a matching manifest path is available. Do not auto-download missing dependencies or silently remove dependent mods.
6. If metadata cannot be interpreted within supported formats/bounds, emit an explicit incomplete-check warning; do not present that pack as fully validated. Keep the existing Java preflight behavior.

## Archive-library limitation

The resolved `zip` 2.4.2 reader builds an `IndexMap` keyed by entry name. Its public `len()`, `file_names()`, and `by_index()` view therefore collapses duplicate raw central-directory names. The preflight can detect repeated paths in Fabric's declared `jars` metadata and missing declared entries, but it does not claim to detect duplicate raw central-directory records. Detecting those requires a separate bounded central-directory parser and is outside this change.

This is a static missing-provider check, not a full Fabric runtime or version solver. Fabric remains authoritative for dependency version ranges and mod code behavior; unsupported/unparseable range syntax must not be claimed as validated. The current regression case is a definite absent-ID conflict, so it can be blocked without guessing versions or violating the pack's environment markers.

## Sources

- [Modrinth `.mrpack` format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack)
- [Fabric `fabric.mod.json` documentation](https://docs.fabricmc.net/develop/loader/fabric-mod-json)
- [Fabric Loader 0.19.3 `ModResolver`](https://github.com/FabricMC/fabric-loader/blob/0.19.3/src/main/java/net/fabricmc/loader/impl/discovery/ModResolver.java)
- [Fabric Loader 0.19.3 `ModDiscoverer`](https://github.com/FabricMC/fabric-loader/blob/0.19.3/src/main/java/net/fabricmc/loader/impl/discovery/ModDiscoverer.java)
- [Modrinth dependencies API](https://docs.modrinth.com/api/operations/getdependencies/)
- [Mod Menu supported environments](https://modrinth.com/mod/modmenu)
- [Simply Tooltips supported environments](https://modrinth.com/mod/simply-tooltips)
- [S-Lib 3.0.1+1.20.1 supported environments](https://modrinth.com/project/VtMfe1Va/version/5qeVCCtb)
- [`zip` 2.4.2 crate](https://docs.rs/crate/zip/2.4.2) — resolved archive reader implementation inspected for the duplicate-name limitation.
