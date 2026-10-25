# Research — CurseForge Server Pack Browser and ZIP Import

**Accessed:** 2026-10-10  
**Scope:** Design a manual CurseForge website + local server-pack ZIP path for Phase 5. No CurseForge Core API integration or key workflow is authorized by this design.

## Current project fit

- Phase 5 currently supports live Modrinth discovery and `.mrpack` install. The Phase 5 spec previously excluded local ZIP import and kept CurseForge disabled pending the separate Core API approval/terms gate. This proposal adds a website-assisted server-pack path without changing Modrinth API behavior.
- Existing Tauri project dependencies are Tauri 2 (the lockfile resolves 2.12.1), React/Vite, and the already-approved `zip = 2.4.2`. No file-dialog or external-opener plugin is present. The only current capability file grants default core/event permissions to the `main` window.
- Reusable implementation surfaces: `src/tabs/Create.tsx` (wizard, progress, cancellation, `addServer`); `src/tauri.ts` (typed IPC and shared job events); `src-tauri/src/installer/mod.rs` (`InstallerState`, job progress/cancel, Modrinth install and staging); `src-tauri/src/modpacks/install.rs` (ZIP parsing and safe path checks); `src-tauri/src/servers/mod.rs` (validation, server publication and rollback); `src-tauri/src/servers/process.rs` (validated Start launch modes); `src-tauri/src/util/paths.rs` (app-data and server roots).
- There is no CurseForge import staging directory, completed-ZIP scanner, native ZIP picker, external opener, or dedicated remote webview today.

## CurseForge website and archive shapes

### Verified facts

- CurseForge's own guide directs a user to open the modpack page, select **Files**, click the desired version, then find **Additional Files** and download the server pack if one is listed. If no server pack is present, the modpack author did not provide one. [CurseForge multiplayer guide](https://blog.curseforge.com/how-to-make-a-multiplayer-minecraft-world-in-java-edition/)
- CurseForge calls Additional Files attachments to a main file and lists Minecraft server files as a common example. [CurseForge file and project types](https://support.curseforge.com/support/solutions/articles/9000197242)
- A CurseForge client-export ZIP has a root `manifest.json` and `overrides/`. The manifest can list project/file IDs for mod downloads that are not bundled in the archive. It is distinct from a self-contained server pack. [CurseForge export instructions](https://support.curseforge.com/support/solutions/articles/9000198500-exporting-a-modpack-for-curseforge-project-submission)
- The CurseForge Core API exposes file metadata including server-pack flags and a server-pack file ID, but access requires application approval and a unique key. Its terms restrict key transfer and API-data caching; project owners may also disable third-party API distribution. [API reference](https://docs.curseforge.com/rest-api/#get-mod-file), [API key application](https://support.curseforge.com/support/solutions/articles/9000208346-about-the-curseforge-api-and-how-to-apply-for-a-key), [third-party API terms](https://support.curseforge.com/support/solutions/articles/9000207405-curseforge-3rd-party-api-terms-and-conditions), [project distribution toggle](https://support.curseforge.com/support/solutions/articles/9000207877)

### Design implications

- The browser instructions should say **Files → choose a version → Additional Files → download the SERVER pack**. Explain that not every pack author provides one.
- A client-export manifest with `files[]` and no server runtime must be classified as **client export requiring additional processing**. Do not call undocumented CurseForge endpoints or resolve IDs through a Core API/key path that remains gated.
- For the first import slice, accept only a self-contained server archive that contains the runtime files required by an existing validated manager launch mode. A filename, `manifest.json`, or one JAR alone is not proof that the archive is ready to run.

## Tauri 2 and WebView2 downloads

### Verified platform behavior

- Tauri's desktop `WebviewWindowBuilder::on_download` reports `DownloadEvent::Requested { url, destination }` and `Finished { url, path, success }`. The handler can assign an absolute destination. Returning `false` for a requested event prevents that download. `success` is authoritative; a missing finished path does not by itself mean failure, and macOS always reports an empty finished path. Tauri exposes the original request URL, not a complete redirect chain. [Tauri builder API](https://docs.rs/tauri/2.12.1/tauri/webview/struct.WebviewWindowBuilder.html#method.on_download), [Tauri `DownloadEvent`](https://docs.rs/tauri/2.12.1/tauri/webview/enum.DownloadEvent.html)
- Tauri's public callback has no byte-progress event and no operation handle for canceling an already-started download. It can route the destination and observe completion only.
- WebView2 `DownloadStarting` can set the absolute result path or cancel before start. `CoreWebView2DownloadOperation` exposes bytes received, state, interrupt reason, `Cancel`, and a `BytesReceivedChanged` event. The expected total may be unknown. An existing result path is overwritten, so destinations must be unique. [WebView2 `DownloadStarting` args](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2downloadstartingeventargs?view=webview2-1.0.4078.44), [WebView2 download operation](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2downloadoperation?view=webview2-winrt-1.0.4022.49), [interrupt reasons](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2downloadinterruptreason?view=webview2-winrt-1.0.3967.48)
- Tauri exposes the Windows WebView2 controller through its platform-webview API, and documents `with_webview` as main-thread access to platform-specific handles. The API warns that underlying platform crates can change across minor Tauri updates. [Tauri `PlatformWebview`](https://docs.rs/tauri/2.12.1/tauri/webview/struct.PlatformWebview.html), [Tauri `with_webview`](https://docs.rs/tauri/2.12.1/tauri/webview/struct.WebviewWindow.html#method.with_webview)
- Tauri supports separate webview windows for external URLs. Child `WebviewBuilder` is marked unstable in the current docs, so a separate managed `WebviewWindow` is the lower-risk embedded-browser option. [Tauri `WebviewWindowBuilder`](https://docs.rs/tauri/2.12.1/tauri/webview/struct.WebviewWindowBuilder.html), [Tauri `WebviewBuilder`](https://docs.rs/tauri/2.12.1/tauri/webview/struct.WebviewBuilder.html)
- Tauri capabilities grant IPC/plugin permissions per window and origin. The remote CurseForge view should receive no local filesystem, server, or general app IPC permissions. [Tauri capabilities](https://v2.tauri.app/security/capabilities/), [Tauri configuration reference](https://v2.tauri.app/reference/config/)
- Tauri's official dialog plugin provides a native file picker; the official opener plugin opens a URL in the user's external browser. Neither is currently installed in this repository. [Tauri dialog plugin](https://v2.tauri.app/plugin/dialog/), [Tauri opener plugin](https://v2.tauri.app/plugin/opener/)
- The plugin docs consulted on 2026-10-10 list `tauri-plugin-dialog` 2.8.1 and `tauri-plugin-opener` 2.7.0. The project lock already contains `webview2-com` 0.39.1 transitively, but Rust's dependency policy still requires consent before adding it as a direct dependency. [Dialog crate docs](https://docs.rs/tauri-plugin-dialog/2.8.1/tauri_plugin_dialog/), [opener crate docs](https://docs.rs/tauri-plugin-opener/2.7.0/tauri_plugin_opener/), [WebView2 binding crate](https://docs.rs/webview2-com/0.39.1/webview2_com/)
- **MSRV conflict:** this repository declares `rust-version = "1.77"`, but its lockfile resolves Tauri 2.12.1. The official Tauri 2.12 release raised the framework MSRV to Rust 1.90; current dialog 2.8.1 and opener 2.7.0 also require 1.90. Older stable plugin releases support Rust 1.77.2 (dialog 2.2.1, opener 2.5.3), but keeping Tauri 2.12.1 still leaves the existing Tauri MSRV requirement. Before code changes, choose whether to align the project's declared MSRV with the locked Tauri 2.12 line or preserve 1.77 and plan a Tauri downgrade. [Tauri 2.12 release/MSRV](https://tauri.app/blog/tauri-2.12/), [dialog 2.2.1](https://docs.rs/crate/tauri-plugin-dialog/2.2.1), [opener 2.5.3](https://docs.rs/crate/tauri-plugin-opener/2.5.3)

### Recommended download lifecycle (Windows/WebView2)

1. Open `https://www.curseforge.com/minecraft` in a dedicated remote `WebviewWindow` with no manager capabilities. Keep navigation and new-window handling scoped to the browser task; expose **Open in External Browser** separately.
2. Intercept each WebView2 `DownloadStarting` event. Sanitize the suggested basename, reserve a unique path under app-data `imports/curseforge/`, and point the operation at a hidden/incomplete `.part` destination. Never allow an existing file to be overwritten.
3. Keep the native `DownloadOperation` handle keyed by an app-generated transfer ID. Emit byte counts and known total to the UI from `BytesReceivedChanged`; show indeterminate progress when the total is unavailable. The Cancel action calls the operation's `Cancel` method.
4. On `StateChanged`, distinguish completed from interrupted. Map user cancellation, network/redirect, permission, disk-space, and WebView shutdown reasons to concise UI messages. Do not log full query-bearing download URLs.
5. On completion, verify WebView2 state and Tauri completion status agree, confirm the file exists and is a readable ZIP, then atomically rename `.part` to its final `.zip` name. Only finalized ZIPs appear in the import list. On cancel/interruption/failure, remove the partial file and retain any previously completed ZIPs.
6. Let WebView2 preserve the site's browser session and redirect behavior. Do not replace a failed webview download by reconstructing the URL or fetching it through a CurseForge API. The app observes the download, but does not implement a separate transfer client.

The Tauri callback alone is insufficient for this UX. The Windows implementation needs a WebView2 event bridge through the platform webview handle (or a maintained Tauri/Wry extension). The repository's dependency policy requires explicit user consent before adding any new direct Rust dependency; check whether a Windows binding can be used without an additional crate, otherwise request consent before implementation. Pin or otherwise verify the Tauri minor version if relying on low-level handles.

### Other desktop platforms and fallback

- Tauri's public download hook can route and confirm a download on desktop, but does not provide the requested byte progress or in-flight cancellation. WebView2 operation-level handling is Windows-specific.
- Do not claim identical managed-download support for macOS/Linux until an equivalent native API is researched and implemented. On an unsupported platform, use **Open in External Browser**, then **Browse for ZIP elsewhere**; copy the chosen archive into the app-managed staging directory. Keep the embedded CurseForge view available only where the app can safely handle its download experience, or clearly label its limited download behavior.
- An external browser cannot be forced by this app to save into its staging folder. The file picker is therefore required for that fallback path.

## Archive validation and server compatibility

### Verified project safeguards

- The already-approved `zip = 2.4.2` dependency is used by Modrinth parsing. The project already has streaming archive inspection, file-count and expanded-size bounds, safe relative-path checks, Windows device-name/reserved-path checks, symlink/reparse rejection, cancellation, disk-space preflight, and staged publication.
- The manager's Start path validates a provider-specific launch mode before creating a process. Existing markers include `server.jar` for Vanilla/Paper/Fabric, Quilt launch files, Forge 1.12.2 universal/server JARs, and Windows argument files for supported modern Forge/NeoForge builds. Start reads the expected Forge/NeoForge argument file only after validating its reference in `run.bat`; it does not run a pack's `.bat` or `.sh` script.
- Current modern NeoForge launch mapping is limited to Minecraft 1.20.1, 1.20.4, 1.20.6, and 1.21. Current new Modrinth pack install supports Vanilla/Fabric/Forge/NeoForge, while the saved-server Start path still includes Quilt. An import must use the exact existing launch-mode checks rather than expand loader support by assumption.
- The importer design narrows its initial support matrix to Forge and NeoForge because their existing Windows argument-file paths encode exact loader/build markers. Vanilla, Paper, and Fabric remain unsupported until their loader/version markers are specified and validated against representative archives; a generic `server.jar` is insufficient. Quilt is detected but rejected for new installs under the current Phase 5 pack policy.

### Recommended import rules

- Inspect archive entries before extraction. Enforce size/count/free-space bounds; reject absolute, traversing, malformed, duplicate-normalized, reserved, symlink, and reparse paths. Extract manually through the approved `zip` API into a new unique server staging folder; never invoke files from the ZIP.
- Recognize the CurseForge client-export signature before considering server-pack markers. Classify it as **client export** and explain that its manifest contains remote file references. It is not installable directly while the API-based resolver remains gated.
- Classify a pack as **supported server pack** only when the selected root is unambiguous, Minecraft and loader/build are detected and consistent, all required pack files are bundled or supplied by an existing verified installer, and `resolve_launch_mode` accepts the staged result.
- Resolve only official Minecraft artifacts and loader dependencies through the manager's existing verified installers/catalogues. Do not download mod files from undocumented URLs, bypass project distribution settings, or rely on scripts bundled in an archive. If a required dependency cannot be obtained through a permitted, hash-verifiable source, fail closed with a clear missing-dependency reason.
- Classify corrupt ZIPs, ambiguous roots, missing runtime files, unknown or mismatched version/loader data, unsupported launch modes, unsafe entries, and resource-limit violations as **invalid or unsupported**. Show the reason before the user starts installation.

The project has not yet established reliable signatures for every CurseForge SERVER archive. Detection should be validated against a small, versioned fixture set before implementation claims broad format support.

## Staging, persistence, and retention

- Use `<app-data>/imports/curseforge/`, separate from `servers/` and installer staging. Do not download or extract into a live or existing server directory.
- The local-file browser must copy the chosen source into staging using a unique destination. Keep the user's original outside file intact, including when the staged copy is eligible for automatic cleanup.
- List only completed `.zip` files; ignore `.part`, transfer IDs, malformed ZIPs, and directories. Provide **Refresh** and **Browse for ZIP** actions and retain existing completed imports after a failed/canceled attempt.
- Reuse the existing cancellable job and progress contract for inspect/install work. Create a new target server directory, apply manager-owned port/MOTD/EULA values, validate the launch files, then publish the server row and directory through the existing atomic publisher. On failure or cancellation, remove only the new server staging folder; keep the ZIP.
- Add a setting **Automatically delete imported ZIP copies after successful installation**, off by default. Delete only the app-managed staged copy, and only after validation, final directory publication, and persistence all succeed. Never delete on failure/cancel; do not delete the original file that the user selected from elsewhere.

## Sources

- [Tauri `WebviewWindowBuilder::on_download`](https://docs.rs/tauri/2.12.1/tauri/webview/struct.WebviewWindowBuilder.html#method.on_download)
- [Tauri `DownloadEvent`](https://docs.rs/tauri/2.12.1/tauri/webview/enum.DownloadEvent.html)
- [Tauri platform webview handle](https://docs.rs/tauri/2.12.1/tauri/webview/struct.PlatformWebview.html)
- [Tauri `with_webview`](https://docs.rs/tauri/2.12.1/tauri/webview/struct.WebviewWindow.html#method.with_webview)
- [Tauri Webview window builder](https://docs.rs/tauri/2.12.1/tauri/webview/struct.WebviewWindowBuilder.html)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri dialog plugin](https://v2.tauri.app/plugin/dialog/)
- [Tauri opener plugin](https://v2.tauri.app/plugin/opener/)
- [`tauri-plugin-dialog` 2.8.1](https://docs.rs/tauri-plugin-dialog/2.8.1/tauri_plugin_dialog/)
- [`tauri-plugin-opener` 2.7.0](https://docs.rs/tauri-plugin-opener/2.7.0/tauri_plugin_opener/)
- [`webview2-com` 0.39.1](https://docs.rs/webview2-com/0.39.1/webview2_com/)
- [Tauri 2.12 release and MSRV announcement](https://tauri.app/blog/tauri-2.12/)
- [`tauri-plugin-dialog` 2.2.1 (Rust 1.77.2)](https://docs.rs/crate/tauri-plugin-dialog/2.2.1)
- [`tauri-plugin-opener` 2.5.3 (Rust 1.77.2)](https://docs.rs/crate/tauri-plugin-opener/2.5.3)
- [WebView2 download-start event args](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2downloadstartingeventargs?view=webview2-1.0.4078.44)
- [WebView2 download operation](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2downloadoperation?view=webview2-winrt-1.0.4022.49)
- [WebView2 interrupt reasons](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2downloadinterruptreason?view=webview2-winrt-1.0.3967.48)
- [CurseForge multiplayer and server-pack guide](https://blog.curseforge.com/how-to-make-a-multiplayer-minecraft-world-in-java-edition/)
- [CurseForge file and project types](https://support.curseforge.com/support/solutions/articles/9000197242)
- [CurseForge client export instructions](https://support.curseforge.com/support/solutions/articles/9000198500-exporting-a-modpack-for-curseforge-project-submission)
- [CurseForge Core API file model](https://docs.curseforge.com/rest-api/#get-mod-file)
- [CurseForge API key application](https://support.curseforge.com/support/solutions/articles/9000208346-about-the-curseforge-api-and-how-to-apply-for-a-key)
- [CurseForge API terms](https://support.curseforge.com/support/solutions/articles/9000207405-curseforge-3rd-party-api-terms-and-conditions)
- [CurseForge project distribution controls](https://support.curseforge.com/support/solutions/articles/9000207877)
- [Rust `zip` entry API](https://docs.rs/zip/2.4.2/zip/read/struct.ZipFile.html)
- [OWASP archive upload testing guidance](https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/10-Business_Logic/09-Upload_of_Malicious_Files/)
- [OWASP file upload limits guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [NeoForge server installation](https://docs.neoforged.net/user/docs/server/)
- [Quilt server installation](https://quiltmc.org/en/install/server/)
- [Fabric server installation](https://wiki.fabricmc.net/install)
