# Specification — CurseForge Server Pack Browser and ZIP Import

> Migration note (2026-10-11): this records the current standalone CurseForge import path. The target contract for the replacement pipeline is [`modpack-server-setup-overhaul.md`](modpack-server-setup-overhaul.md).

## Goal

Add a CurseForge entry point to the existing Create wizard that lets a user view CurseForge in an isolated embedded desktop webview, download an author-provided SERVER pack into app-managed staging, inspect and install a supported ZIP into a new server, then manage and start it through the existing server workflows.

This is a manual website + local archive flow. It does not enable CurseForge Core API access, a shared/user API key, API catalogue search, client-export file resolution, or profile-code import.

## Status and related documents

- **Implemented (2026-10-10); embedded-download follow-up in progress.** Rust check, 73 library tests, 9 focused CurseForge tests, Rust formatting, and the frontend build pass. Live CurseForge/WebView2 download interaction was not exercised.
- Technical evidence: [`../research/2026-10-10-curseforge-server-pack-import.md`](../research/2026-10-10-curseforge-server-pack-import.md)
- Embedded-download report and likely CDN allowlist cause: [`../research/2026-10-10-curseforge-embedded-download-handoff.md`](../research/2026-10-10-curseforge-embedded-download-handoff.md)
- Architecture decision: [`../architecture/adr/0012-curseforge-server-pack-import.md`](../architecture/adr/0012-curseforge-server-pack-import.md)
- Implementation handoff: [`../implementation/curseforge-server-pack-import.md`](../implementation/curseforge-server-pack-import.md)
- The existing Modrinth workflow remains specified in [`modpack-installation.md`](modpack-installation.md).

## Scope boundaries

- CurseForge Core API calls, API-key entry/storage, remote CurseForge catalogue search, and automatic resolution of client-export `projectID`/`fileID` references remain disabled behind the existing API approval/terms gate.
- Client-export ZIPs can be identified and explained, but are not directly installable by this feature.
- The feature accepts a self-contained CurseForge SERVER ZIP, or one whose remaining base runtime can be produced through an existing, verified official Minecraft/loader installer.
- Do not execute `.bat`, `.cmd`, `.sh`, PowerShell, Java, or other pack-provided scripts during validation or installation.
- Preserve all existing Vanilla, Paper, Fabric, Forge, NeoForge, Quilt saved-server management/Start, and Modrinth behavior. Align new imports with the current Phase 5 pack-install policy: detect but reject Quilt for new imports. The initial CurseForge import support matrix may enable only exact, fixture-validated loader layouts; additional loaders remain unsupported until their markers are documented.
- The user approved the required Tauri dialog/opener/WebView2 bindings and aligned the Rust MSRV to 1.90. Do not add further dependencies without explicit user consent.

## User flow

### 1. CurseForge entry and browser

- Add a **CurseForge** choice in the Create wizard, separate from Modrinth search.
- Open the official URL `https://www.curseforge.com/minecraft` in a dedicated managed Tauri `WebviewWindow` when supported.
- The browser view has no app/server/filesystem IPC capabilities. It must not share the main window's permissions. Allow HTTPS navigation to `curseforge.com` and true subdomains plus the official `forgecdn.net` root/subdomains needed for file redirects; reject other hosts and lookalikes. Keep downloads inside the webview rather than reconstructing URLs in a separate network client.
- Provide **Open in External Browser** at all times. On platforms without managed embedded-download progress/cancel, use the external browser + **Browse for ZIP** path or clearly disclose the platform limitation.

### 2. Download instructions and managed download

Display concise instructions beside the CurseForge entry point:

1. Open the modpack's **Files** tab.
2. Select the version to install.
3. Open **Additional Files**.
4. Download the **SERVER** pack. The regular client modpack export is not a server installation archive. Some projects do not have a server pack.

On Windows/WebView2, handle downloads through the native download lifecycle:

- Intercept the WebView2 download start and route it to `<app-data>/imports/curseforge/` with a unique, sanitized, absolute temporary `.part` path.
- Show byte progress when received and total bytes are available; use indeterminate progress when the total is unknown.
- Show active transfer name, state, and a **Cancel download** action. Cancellation must call the live WebView2 download operation. Do not treat closing the browser as a reliable cancel mechanism.
- Observe completion and interruption; show success only after WebView2 reports `Completed` and the Tauri completion result agrees. Report user cancel separately from network, disk, access, redirect, or WebView shutdown errors where available.
- Do not list partial files. On success, confirm a readable ZIP and atomically rename the temporary file to its final `.zip` name. On cancellation/failure, remove only the partial file and retain previously completed ZIPs.
- Use collision-free names; never let a duplicate filename overwrite a completed import.
- Preserve webview cookies and redirects. Permit the official `forgecdn.net` download host tree, while rejecting unrelated cross-origin destinations and lookalike hostnames. If an allowed CDN redirect still fails, report it and offer the external-browser route. Do not fetch the CDN URL through the CurseForge API or guess missing redirect targets.

The high-level Tauri `on_download` event can choose the destination and report completion, but it does not expose in-flight progress or cancellation. A Windows WebView2 operation-level bridge is required for the full managed-download behavior above. macOS/Linux support must not claim parity until a corresponding native progress/cancel path is validated.

### 3. Next and ZIP selection

After the user clicks **Next**:

- Scan only `<app-data>/imports/curseforge/` for completed `.zip` files. Ignore `.part`, temporary, hidden, or currently active downloads.
- Show filename, file size, and last-modified time. Provide **Refresh** and **Browse for ZIP**.
- The native file picker filters to ZIP files. Copy a selected external ZIP to the managed staging directory with a unique name; do not modify or delete the user's original external file.
- Make inspection status and errors visible. Do not extract or create a server merely because a ZIP was selected.

### 4. Archive inspection and classification

Inspect the selected archive before installation. The UI must display one of these classifications and a concise reason:

1. **Supported server pack** — safe ZIP structure, unambiguous server root, consistent detectable Minecraft version + loader/build, required runtime files present or obtainable from an existing verified official installer, and current manager Start validation succeeds for the resulting staging directory.
2. **Client modpack export** — CurseForge export layout with root `manifest.json`, `minecraft`, and file-reference metadata (commonly `files[]` and `overrides/`) but no verified server runtime. Explain that the manifest references remote files and cannot be installed directly. Offer the instructions to return to CurseForge and download a SERVER pack. Do not resolve remote CurseForge IDs in this feature.
3. **Invalid or unsupported archive** — unreadable/corrupt ZIP, unsafe entries, ambiguous root/version/loader, missing required files, unsupported loader/build, or resource bounds exceeded. Show the specific cause and do not enable install.

Detection must rely on archive content and existing verified launch-mode checks, not the filename alone. Version and loader metadata must agree with runtime markers. If any marker is ambiguous or inconsistent, fail closed as invalid/unsupported rather than guessing.

### Initial loader and format support matrix

| Detected loader | Initial import policy | Required evidence |
|---|---|---|
| Vanilla | Unsupported in the initial importer. | `server.jar` is shared by other loaders; keep unsupported until an exact Mojang-specific marker field and version-matching rule are documented and fixture-validated. |
| Paper | Unsupported in the initial importer. | Keep unsupported until an exact Paper-specific marker field and version/build-matching rule are documented and fixture-validated. A generic `server.jar` is insufficient. |
| Fabric | Supported only for recognized ServerPackCreator archives with exact Minecraft and Fabric loader metadata; one outer ZIP wrapper containing exactly one such server ZIP is accepted. Other Fabric layouts remain unsupported. | Require ServerPackCreator metadata with a nonempty `files` inventory, exact Minecraft version, `modloader=Fabric`, exact `modloaderVersion`, safe payload paths, and the existing verified Fabric runtime/Start checks. Never execute included scripts. |
| Forge | Supported only for the existing validated legacy/modern launch layouts and a loader build verified by current installer metadata. | Modern Forge: exact `libraries/net/minecraftforge/forge/{minecraft}-{forge}/win_args.txt`, nonempty `user_jvm_args.txt`, and a `run.bat` reference accepted by the existing parser. Legacy Forge: exact `forge-{version}-universal.jar` plus `minecraft_server.1.12.2.jar`. Parse and verify the Minecraft/Forge builds against current official metadata; require representative fixtures. |
| NeoForge | Supported only for the Minecraft versions currently mapped by the existing launcher and an exact matching NeoForge build. | Exact `libraries/net/neoforged/neoforge/{version}/win_args.txt`, nonempty `user_jvm_args.txt`, a `run.bat` reference accepted by the existing parser, and version prefix mapping for 1.20.1, 1.20.4, 1.20.6, or 1.21; verify the build against current official metadata and require representative fixtures. |
| Quilt | Detected and reported as unsupported for new imports under the current Phase 5 policy. Existing saved Quilt servers retain their current management/Start behavior. | Quilt marker may be used for classification; do not publish a new Quilt server from this workflow. |
| Unknown or mixed | Unsupported. | No fallback or guessed loader selection. |

For every row marked supported, the fixture gate is required before that row is enabled in production. If a row has no validated fixture or exact marker implementation, keep it classified as unsupported. Never infer Paper/Fabric/Vanilla from the shared filename `server.jar` alone. The implemented allowlist is validated Forge/NeoForge layouts plus the recognized ServerPackCreator Fabric format described above. Do not generalize that Fabric support to arbitrary Fabric archives.

### 5. Configure and install

- For a supported server pack, show the detected Minecraft version, loader, and loader build. Show the exact detected values before install; never silently substitute a different version.
- Reuse the existing Create Configure inputs for name, port, RAM, Java path, and explicit EULA acceptance. EULA defaults to false and remains false unless the user checks it.
- Create a new isolated server staging directory. Never write to an existing server directory. Apply the existing manager-owned values and safe `server.properties` behavior.
- Extract archive files manually through the existing approved ZIP dependency after path/reparse/symlink/duplicate/resource checks. Do not execute scripts shipped inside the pack.
- Resolve only base Minecraft/loader runtime assets from the project's existing verified official installers/catalogues when exact metadata is present. Pack-provided mods and required files must be included in the SERVER archive. Do not bypass CurseForge project distribution or API restrictions to retrieve missing mod files.
- Reuse the installer job lifecycle, progress channel, cancellation registry, server validation, atomic publication, persistence, rollback, and `addServer`/Start flow. A failed or canceled job creates no server row/final directory and leaves the ZIP intact.

### 6. Source ZIP retention

- Default: keep the imported ZIP after a successful install.
- Add a setting **Automatically delete staged CurseForge ZIP copies after successful installation**, off by default.
- When enabled, remove only the app-managed staged copy and only after archive validation, new server directory publication, and database persistence all succeed. Never remove it on failure/cancel. Never delete the original external file selected through Browse.

## Archive safety and limits

- Reuse the existing approved `zip` crate and path-safety helpers where their semantics fit; do not use blanket extraction.
- Validate all entry paths before writing: reject absolute/drive/UNC paths, traversal, backslashes/alternate streams, invalid Windows names, manager-reserved files, symbolic links/reparse points, and duplicate normalized destinations.
- Enforce compressed size, entry-count, per-entry/total expanded size, and free-space limits before extraction. Start from existing Modrinth safeguards (2 GiB compressed, 100,000 entries, 20 GiB expanded, plus 512 MiB headroom); validate against representative CurseForge SERVER packs before relaxing or raising them.
- Create all output under a unique app-managed staging root and verify canonical/reparse-safe parents at write time. Never allow archive paths to overwrite database/configuration ownership or escape the new server directory.
- Preserve EULA, port, manager identity/launcher, and runtime safety properties from the existing install path.

## UI and accessibility

- Keep the established flat desktop style, token palette, clear cards, restrained motion, and existing Create wizard hierarchy.
- Make **Open CurseForge** the primary browser action; external browser, Refresh, Browse, and Cancel are clearly secondary.
- Keep one visible current step, provide Back/Cancel routes, disable repeated async actions while busy, and show errors beside the affected action.
- Use visible keyboard focus, descriptive button labels, semantic status/progress announcements, and sufficient contrast. Do not rely on color alone for download/validation state.
- Handle narrow windows without horizontal scrolling. Keep progress and failure states stable; do not move focus to background controls when a status update arrives.

## Acceptance criteria

- [x] Create exposes a CurseForge entry without enabling CurseForge Core API access or asking for an API key.
- [x] Official CurseForge Minecraft page opens in a dedicated isolated embedded webview on the supported Windows desktop path; external-browser fallback is available.
- [x] UI instructions identify **Files → version → Additional Files → SERVER pack** and distinguish client ZIP exports.
- [x] WebView2 downloads save into app-managed CurseForge staging, never a server directory; progress is byte-based when possible and indeterminate when total size is unknown.
- [x] Download cancellation calls the active native operation; completion, duplicate names, redirects, interruption, disk/access errors, and failures have deterministic UI and partial-file cleanup.
- [x] Unsupported platforms receive a clear external-browser + browse flow, not a claim of managed progress/cancel parity.
- [ ] HTTPS navigation policy permits official `forgecdn.net` downloads and true subdomains while rejecting non-HTTPS URLs and lookalike hosts.
- [x] Next lists completed ZIPs only and offers refresh and browse; external files are copied into staging without changing the original.
- [x] Archive classification distinguishes supported server packs, CurseForge client exports, and invalid/unsupported ZIPs before installation.
- [x] Supported archives detect a consistent Minecraft version and loader/build and satisfy the existing validated launch-mode checks.
- [x] No pack script is executed; no missing CurseForge mod payload is fetched through an unapproved API or undocumented endpoint.
- [x] Install uses a new server staging directory and existing installer cancellation, EULA, persistence, atomic publication, and Start paths.
- [x] Failed/canceled imports create no server record/final folder and preserve the source ZIP.
- [x] Automatic deletion is opt-in, off by default, and applies only to the app-managed staged copy after successful validation, publication, and persistence.
- [x] Existing Vanilla, Paper, Fabric, Forge, NeoForge, Quilt saved-server, and Modrinth workflows remain unchanged; Quilt remains unsupported for new imports under current Phase 5 policy.
- [x] Every loader advertised as importable has exact detection criteria and a representative fixture; unvalidated layouts remain unsupported.
- [x] Configure/Install guidance names the validated ServerPackCreator Fabric exception alongside Forge/NeoForge, without implying general Fabric archive support.
- [x] If an embedded download completes but is not a readable ZIP, keep it out of staged imports and show an actionable message. Use only a bounded prefix to identify an obvious HTML error page; never display/log the response body or replace `ZipArchive` validation with signature sniffing.
