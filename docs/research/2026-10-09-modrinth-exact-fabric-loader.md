# Research — Exact Fabric Loader Verification for Modrinth Packs

**Accessed:** 2026-10-09  
**Scope:** Diagnose the user's Prominence II 4.1.1 install failure and verify the official lookup contract for a manifest-pinned Fabric Loader build.

## User-reported case

- Modrinth pack/version: [Prominence II: Hasturian Era 4.1.1](https://modrinth.com/modpack/prominence-2-fabric/version/ZFZUTyJd).
- The official version page lists Minecraft 1.20.1 and Fabric.
- Screenshot shows the 402 MB `.mrpack` archive nearly downloaded, followed by `the Modrinth pack's exact loader build is not currently provider-verified`.

## Code-path finding

- `resolve_modpack_loader_version` takes the exact loader version from the parsed `.mrpack` manifest, then searches `resolve_loader_choices` for an exact match.
- `resolve_loader_choices` deliberately lists only Fabric entries where the metadata's `stable` field is true. Standalone server UI/validation uses this stable-only catalogue.
- The Modrinth pack path also revalidates against stable choices during base server preparation and before publication, and `resolve_install_artifact` calls the same stable-only Fabric validator.
- The observed error therefore means the manifest's exact Fabric build is absent from the stable-only choices. The most likely cause is that the provider lists the pinned build as non-stable; the exact manifest value was not available from the screenshot, so that specific flag remains unconfirmed.

## Official provider contract

- Modrinth `.mrpack` `dependencies` contains IDs and version numbers that launchers use to determine what to install; `fabric-loader` is the Fabric dependency ID. The manifest version is an exact requested build, so replacing it with a different stable build would change the selected pack's declared runtime. [Modrinth `.mrpack` format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack)
- Fabric Meta's `/v2/versions/loader/{game_version}` lists compatible builds and each loader entry includes `stable`; non-stable entries are valid API records. Its `/v2/versions/loader/{game_version}/{loader_version}` endpoint is documented specifically for resolving one loader build with one Minecraft version. [Fabric Meta API README](https://github.com/FabricMC/fabric-meta/blob/master/README.md)
- Fabric's official installer accepts an explicit loader version and resolves the matching version metadata before building the server launcher. [Fabric installation guide](https://wiki.fabricmc.net/install), [Fabric installer metadata lookup](https://github.com/FabricMC/fabric-installer/blob/master/src/main/java/net/fabricmc/installer/util/MetaHandler.java), [server installer](https://github.com/FabricMC/fabric-installer/blob/master/src/main/java/net/fabricmc/installer/server/ServerInstaller.java)

## Minimal fix direction

- Keep the standalone choices catalogue and standalone validator stable-only.
- For a Fabric Modrinth pack, verify the exact manifest pair through Fabric Meta's exact-version endpoint. Require a valid response whose `loader.version` exactly equals the manifest value for the selected Minecraft version; do not require `stable == true` and do not substitute a different build.
- Use that same exact pair for server artifact resolution and repeat the exact check before publication.
- The exact loader build is inside `modrinth.index.json` in the downloaded `.mrpack`; the current version metadata contract exposes supported loader names, not the manifest's exact build. Therefore this build check cannot be moved before the archive download without a separate archive-range/parsing design.
- Add unit coverage for an exact matching response with `stable: false`, and fail-closed cases for wrong/missing/malformed version metadata. No new dependency or CurseForge change is needed.

## Sources

- [Modrinth Prominence II 4.1.1 version page](https://modrinth.com/modpack/prominence-2-fabric/version/ZFZUTyJd)
- [Modrinth `.mrpack` format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack)
- [Fabric Meta API README](https://github.com/FabricMC/fabric-meta/blob/master/README.md)
- [Fabric installation guide](https://wiki.fabricmc.net/install)
- [Fabric installer metadata lookup](https://github.com/FabricMC/fabric-installer/blob/master/src/main/java/net/fabricmc/installer/util/MetaHandler.java)
- [Fabric server installer](https://github.com/FabricMC/fabric-installer/blob/master/src/main/java/net/fabricmc/installer/server/ServerInstaller.java)
