# Research — Prominence II Server Start Dependency Failure

Date: 2026-10-09  
Trigger: User reports that an installed Prominence II server exits after Start. The attached log shows Fabric Loader's mod resolution failing on missing hard dependencies. User confirms the affected servers use pack versions 4.1.2 and 4.1.3.

## Finding

Java launches successfully. Fabric then exits because the pack's server-required mods declare hard dependencies that the `.mrpack` marks `server: unsupported`. The app follows those manifest flags and skips the files, so this is a pack/dependency metadata conflict rather than a Java executable or process-spawn failure.

The user log names these missing dependencies:

- `modmenu`, required by `forgeconfigscreens` 8.0.2
- `s_lib` >=3.0.1+1.20.1, required by Mutant Skeleton Armor Tweaks, Quests & Teams Fixes, Simply Swords Tweaks, and Unrestricted Enchanting
- `simplytooltips`, required by Simply Swords and Simply Bows

## Manifest evidence

The official 4.1.2 and 4.1.3 pack indexes were inspected through bounded byte-range reads of their ZIP central directories and `modrinth.index.json`; neither full archive was downloaded. Both manifests contain the same relevant environment labels:

| File | Manifest server env | Referenced by a server-required mod |
|---|---|---|
| `modmenu-7.2.2.jar` | `unsupported` | Forge Config Screens |
| `s-lib-fabric-3.0.1+1.20.1.jar` | `unsupported` | Mutant Skeleton Armor Tweaks, Quests & Teams Fixes, Simply Swords Tweaks, Unrestricted Enchanting |
| `SimplyTooltips-fabric-0.1.5-1.20.1.jar` | `unsupported` | Simply Swords, Simply Bows |
| `ForgeConfigScreens-v8.0.2-1.20.1-Fabric.jar` | `required` | requires Mod Menu |
| `simply_swords_tweaks-fabric-2.1.0+1.20.1.jar` | `required` | requires S-Lib |
| `simplyswords-fabric-1.70.2-1.20.1.jar` | `required` | requires Simply Tooltips |
| `simplybows-0.1.4.jar` | `required` | requires Simply Tooltips |

The 4.0.5 install-success screenshot and the pasted Start log do not appear to describe the same server: the screenshot names `Hasturian2` on port 25577 and 4.0.5, while the log starts `Hasturian2_1` on port 25580 and contains later mod versions. The user subsequently confirmed both 4.1.2 and 4.1.3 servers fail; those manifests have the conflict above.

## Official metadata cross-check

- Modrinth lists [Mod Menu](https://modrinth.com/mod/modmenu) and [Simply Tooltips](https://modrinth.com/mod/simply-tooltips) as **client-side**. Their `server: unsupported` labels are consistent with their provider metadata.
- Modrinth's exact [S-Lib 3.0.1 version metadata](https://api.modrinth.com/v2/version/5qeVCCtb) lists `client_or_server_prefers_both`. Its `server: unsupported` pack label is inconsistent with the version's server-capable metadata.
- Modrinth's [`.mrpack` format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack) defines `env.server` values `required`, `optional`, and `unsupported`; `unsupported` is a server exclusion. The app's parser installs only `server: required` entries and skips `unsupported` entries in [`install.rs`](../../src-tauri/src/modpacks/install.rs).

## Assessment and safe resolution

- The Start command launches Java and captures the Fabric output. Fabric exits because the installed set is missing dependencies; the attached log provides the failure details.
- Installing Mod Menu or Simply Tooltips on the server would contradict their client-only metadata. The app must not silently override those flags.
- S-Lib is server-capable, but the pack marks it unsupported; this also needs an upstream manifest correction. Correcting only S-Lib would not address the client-only hard dependencies.
- The pack publisher or affected mod authors need to correct server compatibility/dependency metadata: server-required mods must not hard-depend on client-only libraries, and server-capable S-Lib must be marked server-required where needed.
- No app code was changed in this investigation. A future preflight could detect required-mod dependencies on excluded files and fail installation with a clearer error, but it cannot make this pack start without corrected metadata or an explicitly chosen different server mod set.

## Sources

- Modrinth, [Prominence II 4.1.2](https://modrinth.com/modpack/prominence-2-fabric/version/3uZ1MN34) and [4.1.3](https://modrinth.com/modpack/prominence-2-fabric/version/sXMHqA8W) — release pages and pack indexes.
- Modrinth, [Mod Menu](https://modrinth.com/mod/modmenu), [Simply Tooltips](https://modrinth.com/mod/simply-tooltips), and [S-Lib 3.0.1 version metadata](https://api.modrinth.com/v2/version/5qeVCCtb) — official supported-environment metadata.
- Modrinth, [`.mrpack` format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack) — server/client environment field semantics.
