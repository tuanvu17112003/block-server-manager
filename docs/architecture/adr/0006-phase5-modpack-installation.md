# ADR-0006: Phase 5 Modpack Installation

**Status:** Accepted for Modrinth implementation; CurseForge remains gated.  
**Date:** 2026-10-09

## Context

Phase 5 adds remote modpack discovery and installation to a Windows-first Tauri server manager. A pack installation may download large files and apply archive-provided paths, so it must reuse the installer lifecycle's cancellation and staging guarantees. Modrinth defines exact version/file hashes and separate client/server overrides. CurseForge requires an approved, non-transferable API key and its published terms prohibit saving or caching API data; that creates unresolved access and product-use questions.

## Decision

- Resolve a provider's exact pack and version metadata on the backend. Install the declared Minecraft/loader runtime and server-side files into one isolated staging directory; validate files and safe paths; publish the server record and directory only after the entire job succeeds.
- Reuse the existing cancellable job/progress lifecycle, EULA behavior, and publish-after-validation flow. Tauri must never fall back to simulated pack success. Browser mode keeps its existing mocks.
- The first Modrinth implementation supports remote search/version selection and `.mrpack` installation. It does not add local archive import, profile-code import, or pack editing. It applies shared overrides and server overrides, excludes client-only/optional files, and rejects unsupported loader metadata.
- CurseForge commands and UI remain disabled until the user confirms API approval and acceptable terms for this application, including the no-cache restriction. If cleared, use a user-owned key through an OS credential store; never embed a shared app key.
- The user approved `zip` 2.4.2 on 2026-10-09 for `.mrpack` parsing. `keyring` 3.6.3 is approved only for the future user-owned CurseForge key flow and remains deferred while that provider is gated.

## Consequences

- Successful installs are atomic from the server-list perspective; canceled/failed jobs leave no saved record or partial server folder.
- Pack file integrity and path checks become part of the install validation boundary.
- CurseForge support may require a separate product/legal decision or written clarification before it can ship.
- Pack download totals can reach multiple gigabytes; progress, cancellation, and temporary disk use need clear handling.
- New dependencies require explicit user consent before changes to Cargo manifests or lockfiles. The approval applies to ZIP support for Modrinth; keyring use remains conditional on explicit CurseForge authorization.
