# Research 2026-10-08 — Phase 4 Server Installs

## Goal and scope

Phase 4 replaces the Create wizard's simulated server installation with provider-backed version discovery, loader compatibility, and staged server installation. This research covers Mojang Vanilla metadata, Paper Fill, Fabric Meta, Quilt Meta/CLI, Forge promotions/installer, NeoForge Maven/installer, cancellation, integrity checks, and install cleanup.

The application remains Windows x64 and keeps the seven Minecraft versions already supported by Phase 3: 1.12.2, 1.18.2, 1.19.2, 1.20.1, 1.20.4, 1.20.6, and 1.21. Upstream lists are filtered through that catalogue so newer releases do not bypass the Java 8/17/21 boundary. Minecraft 26.1 requires Java 25 and is still excluded.

## Provider findings

- **Vanilla:** the Mojang version manifest points to each version's JSON; its `downloads.server` object supplies the URL, byte size, and SHA-1. Download to a temporary path, verify exact size and SHA-1, then publish as `server.jar`. The manifest endpoint is linked in the project's earlier technical research; the browser research tool did not render its raw JSON in this run.
- **Paper:** Fill API v3 exposes project versions and per-Minecraft build lists. Only a build with `channel == STABLE` is offered. Use `downloads["server:default"].url`, size, and SHA-256. Requests need a descriptive User-Agent with a contact URL or email. No stable build means the Paper/Minecraft combination is unavailable.
- **Fabric:** Fabric Meta publishes compatible game/loader versions and server metadata. The direct `/v2/versions/loader/{mc}/{loader}/{installer}/server/jar` route provides a server launcher; alternatively, the official installer CLI supports a headless server install. Pin the resolved loader and installer versions into the job rather than resolving "latest" while the job is running.
- **Quilt:** Quilt Meta publishes game and loader metadata. Quilt's official server guide documents `java -jar quilt-installer-{version}.jar install server {mc} --download-server`, which creates `quilt-server-launch.jar`. Quilt requests should carry a descriptive User-Agent.
- **Forge:** `promotions_slim.json` maps a Minecraft version to `recommended` and/or `latest` builds. It is a promotions map rather than a complete build catalogue. Present labels distinctly; use the exact selected promotion to construct and validate the installer artifact before execution. Forge's installer source confirms `--installServer` and nonzero exit on failure.
- **NeoForge:** the official server guide uses a Maven installer JAR followed by `--installServer`; Windows output includes `run.bat` and `user_jvm_args.txt`. NeoForge's versioning guide documents the historical version mapping and its newer full Minecraft-version form. Do not infer a compatible MC version solely from a numeric prefix when it cannot be mapped unambiguously.
- **Forge/NeoForge start:** install success is not enough if the desktop process manager cannot run the resulting server. Current Forge server build output includes `run.bat`, `user_jvm_args.txt`, and a loader-specific `win_args.txt`; NeoForge documents `run.bat` and `user_jvm_args.txt`. The process manager must launch these through the selected validated Java while preserving PID identity, stdin/stdout tracking, EULA guard, and stop/kill lifecycle. Legacy Forge output must be handled from its validated artifact shape, not treated as a modern argument-file server.
- **Legacy Forge:** Forge/FML's install notes state that a server is run by executing its Forge/FML JAR with the matching Minecraft server JAR beside it. For the supported 1.12.2 Forge path, validate both exact artifacts and launch the Forge universal JAR directly; do not treat this layout as a modern `win_args.txt` install.
- **Staged paths:** Quilt's documented payload is nested under `server/`. Check the nested directory itself for a Windows reparse point/junction before validating the leaf JAR; a leaf-only metadata check can follow a parent junction outside staging. Windows implements junctions through reparse points; Rust's `symlink_metadata` provides non-following path metadata.

## Progress, cancellation, and safe publication

Provider docs do not define one shared progress or cancellation protocol for installer processes. Vanilla/Paper downloads can report byte progress when metadata supplies size. Installer-based loaders can report stage-level progress and captured stdout/stderr, but the app should not claim a precise percentage for internal dependency downloads.

Run every job in a unique staging directory. A Cancel command signals the active job and terminates any child installer process. Do not create the persistent server record until the expected server launcher/JAR is present and validated. On failure or cancellation, remove staging output and preserve an installer log for the UI/error report; if publication has already begun, roll back both the record and its partial directory.

The EULA is not accepted as part of installation. Write `eula=false` unless the user explicitly checked the existing Create EULA box; only that explicit act may result in `eula=true`. Keep the prior Phase 2 DB/file consistency and `server_start` guard.

## Product and compatibility decisions

- Keep the Phase 3 seven-version Minecraft catalogue as the upper scope boundary; fetch provider metadata live, then intersect with that catalogue and supported Java mappings.
- Paper offers stable builds only. Forge may show recommended and latest as separately labeled choices; a missing promotion is not synthesized.
- Include Vanilla, Paper, Fabric, Quilt, Forge, and NeoForge because all six are named in the Phase 4 plan. Resolve exact compatible versions from their providers and revalidate before install.
- Modpack installation stays in Phase 5. Tauri must not report the current simulated Modrinth/CurseForge pack flow as a successful install; browser mode retains its mocks.
- No new Rust dependencies are required or authorized by the current plan. Reuse the existing Windows `curl.exe`, Java runtime, `std::process`, and `serde_json` patterns.

## Sources

- Mojang version manifest: https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
- Mojang official server download/EULA page: https://www.minecraft.net/en-us/download/server
- Paper Fill API v3: https://docs.papermc.io/misc/downloads-service/
- Fabric Meta API endpoints and compatibility ordering: https://github.com/FabricMC/fabric-meta/blob/master/README.md
- Fabric server download: https://fabricmc.net/use/server/
- Quilt server installer CLI: https://quiltmc.org/en/install/server/
- Quilt Meta API: https://meta.quiltmc.org/
- Forge promotions: https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json
- Forge installer source: https://github.com/MinecraftForge/Installer/blob/2.0/src/main/java/net/minecraftforge/installer/SimpleInstaller.java
- Forge server launcher artifact generation (`run.bat`, `win_args.txt`, `user_jvm_args.txt`): https://github.com/MinecraftForge/MinecraftForge/blob/26.3/build.gradle
- Forge/FML legacy server launch shape: https://github.com/MinecraftForge/FML/blob/master/README.txt
- Windows reparse points and junctions: https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-points ; https://learn.microsoft.com/en-us/windows/win32/fileio/reparse-point-operations ; https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions
- Rust non-following metadata: https://doc.rust-lang.org/std/fs/fn.symlink_metadata.html
- NeoForge server installer: https://docs.neoforged.net/user/docs/server/
- NeoForge versioning: https://docs.neoforged.net/docs/gettingstarted/versioning/
- NeoForge Maven release root: https://maven.neoforged.net/releases/net/neoforged/neoforge/
- Minecraft EULA: https://www.minecraft.net/en-us/eula
- Minecraft 26.1 Java requirement and Phase 3 boundary: `docs/specs/java-provisioning.md` and `docs/research/2026-10-08-phase3-java-provisioning.md`

## Limitations

Forge promotions do not enumerate every build. Fabric/Quilt/Forge/NeoForge installers may resolve or download dependencies internally, so byte-level progress is not consistently available. Modrinth optional-file selection and client-only file filtering belong to the Phase 5 pack-install workflow, where the manifest is available.
