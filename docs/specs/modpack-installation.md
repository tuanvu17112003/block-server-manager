# Specification — Modpack Discovery and Installation (Phase 5)

## Goal

Replace the Create wizard's simulated Tauri modpack browse/install path with provider-backed discovery and an atomic, cancellable server install. Browser development keeps the current mock experience.

## Implementation status (2026-10-09)

- The authorized Modrinth discovery and `.mrpack` installation slice is implemented and passed independent review. Verification is recorded in [`backend-005-modrinth-install-verification.md`](../../.workflow/artifacts/test-logs/backend-005-modrinth-install-verification.md); the final review is in [`backend-005-modrinth-install-review.md`](../../.workflow/artifacts/reviews/backend-005-modrinth-install-review.md).
- CurseForge API access, commands, and key-entry UI remain disabled pending the user's explicit approval after review of the official key requirements and terms. `keyring` is not added because this gated flow is not implemented.
- There was no live Modrinth install smoke test. End-to-end tests for a live curl transfer, redirect chain, and cancellation during transfer remain a coverage limitation.
- Bug follow-up: a Fabric pack's exact manifest-pinned loader build must be verified through Fabric Meta's exact Minecraft+loader endpoint. Stable-only choices remain the policy for standalone installs, but must not reject a provider-listed pack pin; see [`2026-10-09-modrinth-exact-fabric-loader.md`](../research/2026-10-09-modrinth-exact-fabric-loader.md).

## Scope and boundaries

- Remote pack discovery and installation only. Local `.mrpack` import, CurseForge profile-code import, pack editing, and modpack updates are out of scope.
- The manual CurseForge website + self-contained server-pack ZIP flow is specified separately in [`curseforge-server-pack-import.md`](curseforge-server-pack-import.md). CurseForge client-export ZIP resolution remains out of scope.
- Modrinth is the default API provider. CurseForge Core API access remains gated on the user's approval for this application and an acceptable interpretation of the official key and no-cache terms; the website/import flow does not enable that API.
- Keep Windows-first Tauri 2 + React/Vite, existing server install safety, current Java provisioning, and EULA controls.
- Supported pack loaders must map to an existing verified server install/launch mode. Reject Quilt and unknown loader IDs for new pack installs while preserving management/start support for already-saved Quilt servers.
- Do not introduce Rust dependencies without explicit user consent. Candidate dependencies are documented in the Phase 5 implementation guide.

## Discovery and selection

- Modrinth search defaults to modpacks and supports search text, Minecraft version, loader, and popularity/name sorting with paged results.
- Use live project and version metadata, stable project/version IDs, exact compatible Minecraft/loader declarations, and API changelog content. Do not silently substitute a newer pack file or loader version.
- Search/version/API errors are visible, retryable, and never converted to mock data in Tauri.
- The CurseForge Core API catalogue and settings/key entry remain disabled until the access gate in the research note is cleared. The separate website/import entry does not use the Core API. If API access is later approved, use the official API, a user-owned key, exact manifest IDs, and `x-api-key` headers; do not bundle the key.

## Installation

1. The UI sends `modpack_install(input, projectId, versionId, jobId)` where `input` contains server name, selected Minecraft version, supported loader tag, port, RAM, validated Java path, and explicit EULA choice. The backend derives `modpack_id` itself as `modrinth:<projectId>:<versionId>`; it never trusts a UI-provided `modpackId`.
2. Validate project/version IDs, supported game/loader selection, server name, Java runtime, port, EULA choice, and unique job ID before large downloads start. Re-resolve the exact project version and verify the version belongs to the selected project.
3. Register one cancellable job and create a unique staging directory. Emit existing `job://progress/{jobId}` events with stage, sanitized log text, and known byte totals. Use `modpack_install_cancel` over the same `InstallerState`/`JobControl` registry as standalone installs.
4. Fetch the exact primary `.mrpack` file (first file if none is marked primary) from Modrinth metadata. Validate HTTPS host and every redirect hop against the explicit provider allowlist; reject redirects outside that allowlist. Verify the archive's declared size, SHA-1, and SHA-512.
5. Open the ZIP with the approved `zip` crate. Require root `modrinth.index.json`, formatVersion 1, `game == "minecraft"`, a supported Minecraft version, and at most one supported loader dependency. Supported loader IDs are Vanilla (no loader dependency or `minecraft`), Fabric, Forge, and NeoForge. Reject Quilt and unknown IDs. Verify the manifest's Minecraft/loader match the user's selected version/loader and exact loader version is currently provider-verified.
   - For a Fabric Modrinth pack, verify the exact manifest loader version for the exact Minecraft version with Fabric Meta's exact-version endpoint. Do not require the version to appear in the stable-only standalone choices list; do not substitute a different version. Standalone loader choices and their stable-only validation are unchanged.
6. Validate all entry/file paths before writing. Reject absolute paths, drive/UNC prefixes, `..`, backslashes, alternate data streams, Windows device names, symlinks, reparse points, duplicate normalized paths, and paths reserved by the server manager. Limit the `.mrpack` archive to 2 GiB, 100,000 entries, and 20 GiB total expanded contents; preflight free space for the archive, required downloads, overrides, base installer, and 512 MiB headroom.
7. Prepare the base server/loader in the same staging directory with a progress range that leaves room for pack downloads. Install every `files[]` entry, regardless of `env.client`, `env.server`, optionality, or missing environment metadata, per ADR-0008. Preserve each file's `downloads[]` URLs in manifest order, retaining only HTTPS URLs on the reviewed provider allowlist. Download pack files with at most four concurrent workers, each using a fresh temp file per attempt; validate every redirect hop. Rotate through candidate URLs within the existing three-attempt per-file ceiling, retrying the same URL when only one candidate exists. Verify SHA-1 and SHA-512 before placement; a mismatch remains fail-closed after the bounded attempts. `fileSize` supplies the expected progress total and transfer-size cap. The app does not require HTTP `Content-Length` to equal `fileSize`; curl may reject a response whose advertised size exceeds that cap, while a smaller nonzero body is accepted only when both manifest hashes match. Oversized streamed bodies remain rejected by curl and the streaming cap. Never skip-and-continue. Transfers carry connect and low-speed timeouts alongside the total cap.
   Selecting a different pack version must not refetch provider metadata when the Minecraft version is unchanged (skip-if-unchanged + debounce); install-time validation always re-resolves fresh and never trusts these UI hints.
8. Apply safe `overrides/` contents, then `server-overrides/`; skip `client-overrides/`. After stripping the layer prefix, root-level filenames are valid and go directly under staging; nested files create their parent directories. Keep path/reparse/reserved-path checks and never execute files from the pack. Preserve pack `server.properties` entries except application-owned fields (`server-port`, `motd`, and manager defaults); always write `eula.txt` from the user's explicit checkbox after applying pack files.
9. Before publication, confirm the staged server has its verified launcher and required pack files. On failure/cancel, remove staging and create no DB row or final server folder.
10. Begin publication as one cancellation decision point, move the completed folder, persist the backend-derived Modrinth reference, and return the saved server. Preserve rollback if persistence fails.

## UI behavior

- Default search source is Modrinth. Search results use live names, icons, authors, download counts, descriptions, and supported versions.
- Selecting a pack shows an exact version dropdown and the provider changelog. Confirm selected Minecraft version and loader before Configure.
- Configure exposes a game-version choice and only supported dedicated-server loaders from the selected pack version. It displays the exact selected version and loader before install.
- Configure shows the selected pack's supported Minecraft versions and server loaders. Disable install for versions with no supported server-loader mapping.
- Tauri uses a real install command only; it has no simulated timer, fake success, or silent fallback. Browser mode continues to use the current mock packs/progress.
- Install screen shows stage/progress/logs, Cancel, Retry, and a clear client-parity notice. It disables duplicate submissions and never claims a canceled/failed job succeeded.
- The CurseForge API catalogue remains hidden or visibly unavailable until approved; the manual server-pack flow is independent and must not prompt users to paste an API key.

## Acceptance criteria

- [x] Tauri Modrinth search is live, paginated, filtered, and defaults to modpacks; provider errors do not display mock results.
- [x] Pack selection shows live supported versions and changelog, with exact Minecraft/loader selection.
- [x] A supported Modrinth pack installs its server runtime, required dependencies, and safe server overrides with declared size/hash checks; root-level override files are supported.
- [x] The backend revalidates project/version ownership, manifest format/dependencies, and the selected game/loader; it persists the Modrinth project/version reference only after publication.
- [x] Every manifest file is installed without environment-based filtering; all other path and integrity checks remain in force.
- [x] Cancel/failure removes staging and leaves no saved server or partial final folder; success publishes a valid server atomically.
- [x] EULA remains false unless explicitly accepted; current process, Java, Quilt-saved-server, and publication safety remain intact.
- [x] Browser mock browse/install still works; Tauri never reports mock success.
- [x] CurseForge Core API access remains disabled pending the explicit access/terms approval. No CurseForge API command or key-entry flow is present; website-assisted server-pack ZIP import is specified separately.
- [x] Unit/regression tests cover parsing, path traversal/symlink entries, hash/size mismatch, unsupported loaders, cancellation lifecycle, streaming size cap, rollback, and standalone installer behavior. Review noted that live curl transfer, redirect-chain, and cancellation-during-transfer integration coverage is absent.
