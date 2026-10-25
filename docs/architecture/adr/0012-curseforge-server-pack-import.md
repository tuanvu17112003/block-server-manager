# ADR-0012: CurseForge Website and Server-Pack ZIP Import

**Status:** Accepted and implemented.  
**Date:** 2026-10-10

## Context

Phase 5 currently implements Modrinth discovery and `.mrpack` installation. CurseForge Core API access is gated by API approval, key ownership, and no-cache terms. A separate manual path can avoid that API: direct the user to CurseForge's official Minecraft page, then import an author-provided SERVER archive from the website.

The project uses Tauri 2. Its desktop `on_download` hook can route a download and observe completion, but does not expose byte progress or a live cancel handle. On Windows, the WebView2 download operation provides progress/state/interruption/cancel APIs through a lower-level native bridge. Existing server installation already provides an approved ZIP dependency, archive path safeguards, cancellable jobs, validated launch modes, EULA behavior, and publish-after-validation persistence.

CurseForge client-export ZIPs have a `manifest.json` and can reference remote mod files that are not in the ZIP. They are not equivalent to a self-contained server pack; resolving those IDs would re-enter the API/key/terms gate. The manager must not execute archive-provided scripts or retrieve missing mod files through undocumented endpoints.

## Decision

- Add a manual CurseForge website + local SERVER ZIP workflow, separate from Modrinth provider APIs and CurseForge Core API access.
- Open the official CurseForge page in a dedicated remote webview with no manager capabilities. Permit HTTPS navigation to CurseForge pages and the official `forgecdn.net` download host tree so website redirects can reach WebView2's download event; reject other hosts and lookalikes. Provide an external-browser fallback and a native ZIP selection flow that copies externally chosen files into managed staging.
- Stage downloads/import copies under `<app-data>/imports/curseforge/`, never in a server folder. Use collision-free temporary paths; expose only completed ZIPs.
- On Windows/WebView2, use the native download operation for bytes/total, state, interruption reasons, and in-flight cancel. The Tauri `on_download` hook alone is insufficient for those behaviors. Do not claim macOS/Linux progress/cancel parity until native equivalents are validated.
- Inspect archives before server creation. Distinguish a supported self-contained server pack, a CurseForge client export, and invalid/unsupported input. Require consistent version/loader metadata and an existing validated manager launch mode; fail closed on ambiguous packages. Align new-import loader support with current Phase 5 policy: the initial support matrix is limited to fixture-validated Forge and NeoForge layouts; keep Vanilla, Paper, and Fabric unsupported until exact markers are documented and validated; detect and reject Quilt for new imports while preserving saved Quilt servers.
- Reuse existing installer cancellation, safe extraction, explicit EULA, server configuration, atomic publication, persistence, and Start behavior. Never run server-pack scripts.
- Resolve only exact base Minecraft/loader assets through the existing verified official installers/catalogues. Do not fetch missing CurseForge mod files or add API commands/credentials under this decision.
- Preserve the ZIP by default. If an explicit setting is enabled, delete only the app-managed copy after validation, publication, and persistence all succeed. Keep an external original untouched.
- Do not add a Rust dependency without explicit user consent. The implementation plan identifies the platform bridge and native file-picker/external-opener needs before code work proceeds.
- Preserve current Vanilla, Paper, Fabric, Forge, NeoForge, Quilt saved-server, and Modrinth behavior. Require representative fixtures and exact markers before enabling any loader row; Quilt remains unsupported for new imports.

## Consequences

- Users can install only packs whose SERVER archive contains a complete runtime or whose missing base runtime is obtainable through existing verified official installers.
- Client exports remain a helpful, explainable unsupported classification rather than triggering API calls, key prompts, or silent partial installs.
- Windows can deliver managed in-app download progress/cancellation using WebView2. Other desktop platforms need their own native implementation or use the external-browser + ZIP-picker route.
- Import adds an app-managed staging lifecycle and a retention preference. Partial download files remain hidden and are cleaned on failure.
- Archive detection is heuristic until validated against representative SERVER ZIP fixtures. Initial supported rows are Forge and NeoForge only; a row without documented exact signatures/fixtures stays unsupported; ambiguous layouts fail closed.
- The user explicitly approved the required file-picker, opener, WebView2, and Windows COM dependencies. Any additional Rust dependency still requires explicit consent.
- The repository initially declared Rust 1.77 while locked Tauri 2.12.1 is on the framework's Rust 1.90 MSRV line. The user approved aligning the declared MSRV with Tauri 2.12 before implementation.
- User approved aligning the declared MSRV to 1.90 and adding Tauri dialog/opener plus Windows WebView2 bindings (`webview2-com` 0.39.1 and `windows-core` 0.62.2). The direct `windows-core` dependency supplies the `Interface` trait required by the WebView2 bridge.
- No CurseForge API access, key storage, client-export resolution, or script execution was added.

## References

- [`curseforge-server-pack-import.md` specification](../../specs/curseforge-server-pack-import.md)
- [`2026-10-10-curseforge-server-pack-import.md` research](../../research/2026-10-10-curseforge-server-pack-import.md)
- [Existing Phase 5 Modrinth decision (ADR-0006)](0006-phase5-modpack-installation.md)
- [Embedded download handoff research follow-up](../../research/2026-10-10-curseforge-embedded-download-handoff.md)
