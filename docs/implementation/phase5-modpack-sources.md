# Implementation Guide — Backend Phase 5 Modpack Sources

Read first: [`../specs/modpack-installation.md`](../specs/modpack-installation.md), [`../research/2026-10-09-modpack-sources.md`](../research/2026-10-09-modpack-sources.md), [`../architecture/adr/0006-phase5-modpack-installation.md`](../architecture/adr/0006-phase5-modpack-installation.md), and [`backend-plan.md`](backend-plan.md) §Phase 5.

## Pre-implementation gates

- User approved `zip = 2.4.2` (default features disabled, `deflate` enabled) on 2026-10-09; it supports the declared Rust 1.77 MSRV and may be added for Modrinth `.mrpack` parsing.
- User conditionally approved `keyring = 3.6.3` only if needed for an approved CurseForge credential flow. It is not needed for Modrinth and has not been added; no key-entry or credential-management UI is active.
- CurseForge implementation is blocked until the user confirms this app has approved API access and acceptable terms for key ownership, API metadata caching, and local installed artifacts. Do not register CurseForge commands or prompt for a key before that gate clears.
- The currently authorized installation implementation is Modrinth only.

## Implementation status (2026-10-09)

- Modrinth catalog discovery, exact version selection, and cancellable `.mrpack` installation are implemented. The independent review passed after a strict streaming download-size cap was added; see [`backend-005-modrinth-install-review.md`](../../.workflow/artifacts/reviews/backend-005-modrinth-install-review.md) and [`backend-005-modrinth-install-verification.md`](../../.workflow/artifacts/test-logs/backend-005-modrinth-install-verification.md).
- The direct `zip = 2.4.2` dependency is installed with only `deflate`; no keyring or CurseForge API access is present.
- No live Modrinth install smoke test was performed. The reviewer noted that live curl, redirect, and transfer-cancellation integration scenarios are not covered end to end.
- CurseForge remains a separate user-approval gate. Its official application requirements and terms were researched in [`2026-10-09-modpack-sources.md`](../research/2026-10-09-modpack-sources.md), but the user has not approved enabling its API access.
- Loader verification bug follow-up: use Fabric Meta's exact Minecraft+loader endpoint for Modrinth manifest-pinned Fabric builds at initial resolution, server artifact setup, and final pre-publication validation. Keep standalone loader choices stable-only. Research and acceptance details: [`2026-10-09-modrinth-exact-fabric-loader.md`](../research/2026-10-09-modrinth-exact-fabric-loader.md) and [`modpack-installation.md`](../specs/modpack-installation.md).

## Owned paths

- Backend: `src-tauri/src/modpacks/**` (new), `src-tauri/src/installer/**`, `src-tauri/src/servers/**`, `src-tauri/src/lib.rs`, and narrowly required DB/IPC files.
- Frontend: `src/tauri.ts`, `src/tabs/Create.tsx`, and narrowly required `src/types.ts`/store changes.
- Documentation: Phase 5 spec, research, ADR, and indexes.
- Do not edit unrelated tabs or revise the standalone loader catalogue. If an additional shared interface or dependency is required, stop and report before expanding scope.

## Ordered steps

1. DONE — add only the approved `zip` dependency; keep the project's Rust 1.77 MSRV and enable only `deflate`.
2. DONE — add typed install/cancel requests; derive the persisted Modrinth reference in the backend.
3. DONE — re-fetch the exact Modrinth version, verify project ownership and file selection, download the `.mrpack` with size/hash checks, and validate every redirect hop.
4. DONE — parse formatVersion 1, resolve the Minecraft/loader dependency through verified installer metadata, and reject Quilt, unknown, or mismatched dependencies.
5. DONE — download and verify required server files; skip optional/client-only/unknown-environment payloads; apply safe shared and server overrides without executing scripts.
6. DONE — reuse the installer job registry, stage the base server and pack together, enforce archive paths/resource bounds, preserve explicit EULA choice, and publish the server/DB record atomically.
7. DONE — persist the backend-derived reference while standalone `server_install` rejects UI-provided IDs; preserve manager-owned EULA and network properties.
8. DONE — wire Tauri Create install/cancel; preserve browser mocks; keep CurseForge out of commands and UI until its gate clears.

## Modrinth catalog IPC contract

- `modrinth_search_modpacks(query, gameVersion, loader, index, offset, limit)` returns `{ results, offset, limit, totalHits }`. Each result has `{ id, name, author, downloads, gameVersions, loaders, iconUrl, summary }`. Search uses the `project_type:modpack` facet; provider `index` is one of `relevance`, `downloads`, `follows`, `newest`, or `updated`; `limit` is clamped to 1–100.
- `modrinth_project_versions(projectId, gameVersion, loader)` returns exact compatible versions with `{ id, name, versionNumber, gameVersions, loaders, changelog, files }`; each file has `{ url, filename, size, primary, hashes: { sha1, sha512 } }`. The UI selects an explicit version ID and never substitutes a different file.
- `modpack_install(input, projectId, versionId, jobId)` accepts `input = { name, minecraftVersion, loader, port, ramMb, javaPath, eulaAccepted }` and returns the saved `ServerDto`. `loader` is one of `minecraft`, `fabric`, `forge`, or `neoforge`; the UI does not supply a loader build or persisted `modpackId`. The backend maps `minecraft` to the Vanilla server runtime.
- `modpack_install_cancel(jobId)` cancels a registered pack job through the same `InstallerState`/`JobControl` registry as standalone installs. It may be implemented as a typed alias over `server_install_cancel` if both call the same registry.
- The backend downloads the exact version's primary `.mrpack` file (first file if no primary is marked), verifies its size/SHA-1/SHA-512, derives actual loader version from the archive dependency, and confirms it matches the selected game/loader before publication. Persist `modrinth:<projectId>:<versionId>` only after successful staging.
- Modrinth ZIP safety bounds for v1: at most 100,000 archive entries, at most 2 GiB compressed `.mrpack`, at most 20 GiB total expanded archive entries, and a free-space preflight for the compressed archive, required file downloads, expanded overrides, plus 512 MiB headroom. Reject over-limit packs with a clear retryable validation error.
- Rust command parameters use snake_case; Tauri/TypeScript payload properties use camelCase. The new source only serves Modrinth; it never falls back to mock results under Tauri.
- The existing UI's `Name A-Z` sort is applied to the current response page only; Modrinth does not expose an alphabetical server sort. Popular maps to provider `downloads` order.

## Modrinth install IPC contract

- `modpack_install(input, projectId, versionId, jobId)` accepts `input = { name, minecraftVersion, loader, port, ramMb, javaPath, eulaAccepted }` and returns the saved `ServerDto`. `loader` is a lowercase tag from `minecraft`, `fabric`, `forge`, or `neoforge`; do not accept Quilt, Paper, or unknown tags for pack installation.
- The backend fetches `/v2/version/{versionId}`, verifies its `project_id` equals `projectId`, selects the primary `.mrpack` file (or the first file if none is primary), and validates the `.mrpack` manifest against the selected game/loader before installing.
- `modpack_install_cancel(jobId)` cancels a registered job through the same `InstallerState`/`JobControl` registry as standalone server installs.
- The backend derives and persists `modpackId` as `modrinth:<projectId>:<versionId>` after success. It rejects a client-supplied `modpackId` on `server_install`.
- Installer progress stays monotonic: reserve a progress range for base server/loader setup, then report archive/required-file download and override stages before validation/publication.
- The approved ZIP bound is 2 GiB compressed, 100,000 entries, and 20 GiB expanded. Preflight free space for the archive, required file downloads, expanded overrides, base installer, and 512 MiB headroom. The only new dependency is `zip = { version = "=2.4.2", default-features = false, features = ["deflate"] }`.
- Treat `eula.txt`, generated `server-port`, `motd`, and server manager identity/launcher files as manager-owned. Pack server.properties values may fill other keys, but must not override these safety values.

## Verification checklist

- Review independently for request/redirect host validation, archive traversal/reparse-point escapes, decompression limits, key/log leakage, cancellation/publication races, and no mock-success path under Tauri.
- Tests cover manifest/dependency validation, hashes and declared sizes, malicious archive paths, cancellation job lifecycle, streaming size overflow, and publication rollback. The reviewer identified no blocking coverage gap, but live curl, redirect-chain, and cancellation-during-transfer integration tests remain absent.
- Run TypeScript/build, Rust tests/check/format, and affected standalone Phase 4 regression coverage under the project workflow. Do not claim CurseForge acceptance without approved API access and a verified live request.
