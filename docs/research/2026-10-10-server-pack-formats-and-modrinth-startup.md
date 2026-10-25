# Research — Server Pack Formats and Modrinth Startup Failures

Date: 2026-10-10  
Scope: The two supplied CurseForge ZIPs, the two supplied server logs, current CurseForge packaging guidance, Modrinth `.mrpack` semantics, and Fabric mod metadata relevant to runtime compatibility.

## Findings from the supplied archives

### Prominence II 4.1.3

- The downloaded file is a ZIP containing one more ZIP: `Prominence™_II_Hasturian_Era_v.4.1.3_server_pack.zip`.
- The inner ZIP contains 3,501 entries, including 365 mod JARs, `config/`, `datapacks/`, `defaultconfigs/`, `manifest.json`, `start.bat`, `start.ps1`, `start.sh`, `variables.txt`, and `HOW-TO-RUN.md`.
- Its `manifest.json` is ServerPackCreator metadata, not a CurseForge client-export manifest. It identifies Minecraft `1.20.1`, Fabric Loader `0.19.3`, and ServerPackCreator `8.1.2`; its `files` inventory uses Windows-style separators and is larger than the archive entry count.
- `variables.txt` recommends Java 17 and `-Xmx8G -Xms8G`. The included scripts perform loader setup/launch work. They are untrusted pack data and must never be executed by the manager.
- Correct handling: unwrap exactly one single-file ZIP wrapper; recognize the ServerPackCreator metadata; provision the exact official Fabric runtime using the manager's existing installer; safely overlay pack files; retain scripts as files without using them as the manager's launch path.

### Craft to Exile 2 2.1.4

- This archive is already rooted at server files. It contains 10,223 entries, 332 `mods/*.jar`, 96 library JARs, Forge `win_args.txt` and `unix_args.txt`, `run.bat`, `run.sh`, `user_jvm_args.txt`, and configuration directories.
- `run.bat` references `libraries/net/minecraftforge/forge/1.20.1-47.4.23/win_args.txt`. The archive contains all 58 distinct JAR paths in that argument file.
- The screenshot's reported missing payloads come from `-DignoreList=...`: the value is a comma-separated list of JAR basenames, not filesystem paths. The current validator splits on semicolons/colons but not commas, then treats the whole value as one path because it ends in `.jar`.
- Correct handling: do not interpret `-DignoreList` as a payload path. Continue validating actual classpath/module-path references and the argument file itself against normalized archive entries.

## Findings from the supplied logs

- `ddac40b3-9bc6-4132-bef0-f65ffb1682b3`: Fabric reports that Cobblemon requires Java 21 while the server uses Java 25. Fabric's incompatibility report is the startup blocker; the malformed SemVer line is only a warning. This is a runtime constraint mismatch, not evidence of a missing Modrinth download.
- `06b1a81c-5daa-4486-a85d-9696ac561b82`: REI, YACL, and `amethyst_core` are absent recommendations; Fabric calls them recommendations and warns rather than failing. The hard startup failure is `colorwheel_patcher` loading `ClientLifecycleEvents` in a dedicated-server environment. The `shut-up-mcd` client mixin error is also nonfatal in this log.
- Before this task, the installation parser deserialized path, hashes, downloads, and file size for each `.mrpack` entry, ignored optional `env.server` metadata, and installed files marked unsupported on servers. This could place client-only code in `mods/`.
- Missing recommendations should not be fetched as if they were mandatory pack contents. The selected `.mrpack` index is the exact pack file list; loader `recommends` warnings are soft dependency notices, not proof that required pack files were omitted.

## Platform guidance and design implications

- CurseForge documents a separate creator-prepared server ZIP, commonly containing `mods/`, `config/`, and optionally `kubejs/`; startup scripts and `server.properties` are optional. It does not define one universal server-pack schema. A ZIP extension is the supported input container, but archive contents need explicit classification.
- A normal CurseForge client export has `manifest.json` plus `overrides/` and references remotely hosted project/file IDs. The manager does not use CurseForge Core API access, so that client export remains unsupported and must not be mistaken for a server pack.
- Modrinth's `.mrpack` format defines `env.server` values `required`, `optional`, and `unsupported`. `unsupported` means the file cannot be installed server-side. Required files are installed. The product policy in this task keeps optional files included by default, while unsupported server files are excluded and reported.
- Modrinth requires `modrinth.index.json` at ZIP root, files are installed at declared paths, and server overrides apply after shared overrides. Existing code already handles root-level paths and applies `overrides/` then `server-overrides/`.
- Fabric's `fabric.mod.json` may declare a `depends.java` version/range. Fabric uses that metadata for a hard startup check. Validate supported simple Java-major constraints in server mod metadata during install so a server with Java 25 is not published when a required mod declares Java 21 exactly.
- CurseForge packaging guidance is tutorial-level, not a format specification. Support only recognizable formats and fail with an actionable unsupported-format reason when metadata is ambiguous or incomplete.

## Sources

- CurseForge, [Server Packs Tutorial](https://blog.curseforge.com/server-packs-tutorial/) — recommended server ZIP contents and optional startup files.
- CurseForge, [Exporting a Modpack for project submission](https://support.curseforge.com/support/solutions/articles/9000198500-exporting-a-modpack-for-curseforge-project-submission) — client-export manifest and `overrides/` layout.
- ServerPackCreator, [project documentation](https://github.com/Griefed/ServerPackCreator) and [ServerPackManifest API](https://griefed.pages.griefed.de/serverpackcreator/-server-pack-creator/de.griefed.serverpackcreator.api.serverpack/-server-pack-manifest/index.html) — supported loaders and manifest fields (`files`, Minecraft version, modloader, modloader version).
- Modrinth, [Modpack Format (.mrpack)](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack) — file paths, hashes, environment values, redirects, and override layers.
- Modrinth, [Get all of a project's dependencies](https://docs.modrinth.com/api/operations/getdependencies/) — dependency types and version metadata; not a substitute for the exact `.mrpack` file list.
- Fabric, [fabric.mod.json](https://docs.fabricmc.net/develop/loader/fabric-mod-json) — environment, dependency resolution, and Java version predicates.
- Local evidence: the two supplied ZIPs, screenshot, and `latest.log` files named in the user request. No archive script was executed.

