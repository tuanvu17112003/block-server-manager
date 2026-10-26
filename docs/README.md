# Docs — Minecraft Server Manager (Desktop)

Lean implementation-ready knowledge. See `WORKFLOW.md §3.3`.

## Existing server-pack behavior and prior corrections

- `research/2026-10-10-server-pack-formats-and-modrinth-startup.md` — supplied ZIP/log evidence and official format guidance.
- `research/2026-10-11-open-source-solutions-review.md` — review of the supplied OSS survey, adoption fit, and the app-specific support-copy correction.
- `research/2026-10-11-reported-modpack-setup-failures.md` — initial triage of the user's reported missing/extra-mod and CurseForge format symptoms; exact repro evidence remains needed.
- `architecture/adr/0013-server-pack-format-and-server-mod-policy.md` — supported CurseForge layouts, Modrinth server-side filtering, and Java compatibility policy.
- `specs/server-pack-install-correctness.md` — format, runtime, and acceptance requirements.
- `implementation/server-pack-correctness.md` — owned paths and ordered implementation checklist.
- These provider-specific notes describe the current implementation during migration. The target contract is in `specs/modpack-server-setup-overhaul.md`.

## Modpack setup pipeline overhaul

- `research/2026-10-18-framework-neutral-backend.md`, `architecture/adr/0019-framework-neutral-http-backend-contract.md`, `specs/framework-neutral-backend-api.md`, and `api/openapi.yaml` — HTTP/SSE contract for deploying the frontend with any compatible backend framework.
- `research/2026-10-13-modrinth-preview-ipc-casing.md` and `specs/modrinth-preview-ipc-contract.md` — root cause and wire contract for Modrinth preview IPC deserialization failures.
- `research/2026-10-12-phase6-diagnostic-handle-containment.md` — post-open containment, bounded scan disclosure, and crash-report disappearance requirements from Phase 6 review.
- `research/2026-10-12-tauri-mcp-bridge.md` — compatible Tauri MCP Bridge/Tauri pins, debug-only loopback binding, isolated app data, and read-only smoke-test boundaries.
- `research/2026-10-11-modpack-overhaul-design-review.md` — reviewed candidate fit, implementation references, and user scope decisions.
- `research/2026-10-11-archive-fingerprint-consistency.md` — official CNG guidance for hashing one stable archive byte stream.
- `research/2026-10-11-loader-redirect-security.md` — official curl redirect semantics and per-hop loader host policy.
- `architecture/adr/0016-modpack-setup-pipeline-rebuild.md` — unified in-app pipeline decision and preserved safety boundaries.
- `architecture/adr/0017-stable-modpack-archive-fingerprints.md` — ties both archive digests and classification to one bounded snapshot.
- `architecture/adr/0018-loader-redirect-policy.md` — validates loader metadata and artifact redirect hosts for the new pipeline.
- `specs/modpack-server-setup-overhaul.md` — provider inputs, file policy, exact loaders, transaction, launch, reporting, and acceptance criteria.
- `implementation/modpack-server-setup-overhaul.md` — phased owned paths and quality gates; implementation is not started before review.

## Modrinth runtime and Fabric metadata preflight (current follow-up)

- `research/2026-10-10-modrinth-runtime-and-fabric-metadata.md` — screenshot diagnosis, local BetterEnd metadata/log evidence, and Fabric's actual Java predicate/parser rules.
- `architecture/adr/0014-modrinth-java-runtime-and-fabric-metadata-preflight.md` — distinguish Minecraft's recommended Java from mod predicates; parse Fabric metadata compatibly and before expensive overrides.
- `specs/server-pack-install-correctness.md` — runtime selection, metadata scanning, and error-timing acceptance criteria.
- `implementation/modrinth-runtime-and-fabric-metadata.md` — owned paths, implementation order, and regression checklist.

## Modrinth missing hard dependencies (current task)

- `research/2026-10-10-modrinth-missing-hard-dependencies.md` — the failed server's exact log/install evidence, Prominence II manifest conflict, and Fabric Loader 0.19.3 behavior.
- `architecture/adr/0015-block-modrinth-packs-with-missing-server-dependencies.md` — preserve server-unsupported exclusions and block publication for definite unresolved Fabric hard dependencies.
- `specs/server-pack-install-correctness.md` — effective server mod dependency preflight requirements.
- `implementation/modrinth-missing-hard-dependencies.md` — owned paths, bounded scan design, and regression checklist.

## Full version catalogue links (backend-006)
- `research/2026-10-09-full-version-catalogue.md` — all-installable-build contracts per provider (Paper channels, Fabric stable flag, Forge catalogue, NeoForge mapping, Mojang snapshot types).
- `architecture/adr/0007-full-version-catalogue.md` — artifact-completeness gating, stability labels, stable-by-default toggle.
- `specs/server-installs.md` — revised Discovery and Acceptance sections for the full catalogue.
- `implementation/full-version-catalogue.md` — owned paths, ordered backend + UI steps, verification checklist.

## Download reliability links (backend-007)

- `research/2026-10-09-modpack-download-reliability.md` — truncated-file mechanism, sequential-download costs, 6-round-trip rescan chain.
- `specs/modpack-installation.md` §Installation step 7 — retry semantics, header fail-fast, rescan freshness rule.
- `implementation/modpack-download-reliability.md` — owned paths, ordered steps, verification checklist.

## Download reliability rework (backend-008)

- `research/2026-10-09-modrinth-download-reliability-rework.md` — repeated Content-Length discrepancy, Modrinth hash/size contract, sequential-download bottleneck, bounded-worker research.
- `specs/modpack-installation.md` §Installation step 7 — hash-authenticated size reconciliation and four-worker ceiling.
- `implementation/modpack-download-reliability-rework.md` — scoped backend steps and verification criteria.

## Download source failover (backend-009)

- `research/2026-10-09-modrinth-download-source-failover.md` — recovered backend-008 context, Modrinth URL/hash contract, and the confirmed first-URL-only retry gap.
- `specs/modpack-installation.md` §Installation step 7 — ordered trusted URL candidates and bounded failover behavior.
- `implementation/modpack-download-source-failover.md` — owned paths, ordered implementation steps, constraints, and acceptance checklist.

## Prominence II server startup investigation (backend-011)

- `research/2026-10-09-prominence-ii-server-start-dependencies.md` — Fabric missing-dependency log, 4.1.2/4.1.3 manifest flags, official mod environment metadata, and safe resolution.

## Modrinth root-level override failure (backend-012)

- `research/2026-10-09-modrinth-root-level-overrides.md` — official `.mrpack` semantics and the root-level destination-parent failure.
- `specs/modrinth-overrides.md` — server override extraction behavior and acceptance criteria.
- `implementation/modrinth-root-level-overrides.md` — scoped implementation steps and verification checklist.

## Prior Modrinth all-files install policy (backend-014; superseded)

- `research/2026-10-09-modrinth-all-pack-files.md` — historical filtering behavior, exact 4.0.5 manifest findings, and the earlier user-directed policy.
- `architecture/adr/0008-install-all-modrinth-pack-files.md` — superseded by ADR-0013.
- `specs/modrinth-all-pack-files.md` and `implementation/modrinth-all-pack-files.md` — historical all-files guidance; see `specs/server-pack-install-correctness.md` for current behavior.

## Console log performance (backend-015)

- `research/2026-10-09-console-log-performance.md` — unbounded log-state/full-DOM rendering evidence and official React/Tauri sources.
- `architecture/adr/0009-bounded-virtualized-console-logs.md` — bounded history, batched updates, and viewport-only rendering.
- `specs/console-log-performance.md` — console behavior and acceptance criteria.
- `implementation/console-log-performance.md` — owned paths, constraints, and verification checklist.

## Server heap launch parity (backend-018)

- `research/2026-10-10-server-initial-heap.md` — app/BAT command comparison, matching server/mod hashes, and Java heap references.
- `architecture/adr/0010-match-configured-initial-server-heap.md` — use configured RAM for both initial and maximum JVM heap while retaining managed process launch.
- `specs/server-initial-heap.md` — launch behavior and acceptance criteria.
- `implementation/server-initial-heap.md` — owned path, constraints, and verification checklist.

## Backend Phase 6 Console (backend-019)

- `research/2026-10-10-console-backend-phase6.md` — current process/logging surfaces, platform research, and unresolved RCON/clear/history decisions.
- `specs/console-backend.md` — proposed backend IPC and persistence behavior; detached RCON remains gated on a loopback-safe design.
- `implementation/backend-phase6-console.md` — owned paths, ordered work, verification criteria, and the current pre-implementation gate.

## Console stream resilience (backend-020)

- `research/2026-10-10-console-stream-encoding.md` — malformed byte evidence at the Console freeze point and Rust buffered-reader semantics.
- `specs/console-stream-resilience.md` — lossy decoding and continued child-stream behavior while retaining the existing Tauri event contract.
- `implementation/backend-020-console-stream-resilience.md` — one-file implementation steps, regression checks, and user-owned live smoke constraints.

## Prominence II retest version (backend-010)

- `research/2026-10-09-prominence-ii-retest-version.md` — targeted 4.1.1hf hash regression versus the current 4.1.2 general install test.

## CurseForge inspect unicode path (curseforge-inspect-unicode-path)

- `research/2026-10-10-curseforge-inspect-unicode-path.md` — staged `™` ZIP inspect failure (os error 267), file-vs-directory root cause, and fix guidance.
- `implementation/curseforge-inspect-unicode-path.md` — owned paths, ordered fix steps, and verification checklist.

## Phase 5 links
- `research/2026-10-10-curseforge-server-pack-import.md` — official server-pack UX, WebView2 downloads, archive safety, and API/dependency boundaries.
- `research/2026-10-10-curseforge-webview2-bridge-follow-up.md` — WebView2 binding dependency resolution and import safety review follow-up.
- `research/2026-10-10-curseforge-embedded-download-handoff.md` — user-reported embedded download stall, likely CDN navigation allowlist cause, and safe regression criteria.
- `architecture/adr/0012-curseforge-server-pack-import.md` — isolated website + local server-pack ZIP decision without CurseForge Core API access.
- `specs/curseforge-server-pack-import.md` — browser, staging, classification, install, retention, and acceptance criteria.
- `implementation/curseforge-server-pack-import.md` — dependency gates and ordered implementation checklist.
- `research/2026-10-09-modpack-sources.md` — Modrinth/CurseForge APIs, archive formats, dependency fit, and provider gates.
- `research/2026-10-09-modrinth-install-details.md` — Modrinth download allowlist, ZIP extraction safeguards, resource bounds, and loader interpretation.
- `research/2026-10-09-modrinth-exact-fabric-loader.md` — Prominence II install failure and exact Fabric Meta loader verification contract.
- `research/2026-10-09-curl-stream-size-limit.md` — why the installer must enforce declared byte limits during system curl transfers.
- `architecture/adr/0006-phase5-modpack-installation.md` — proposed staged installation and gated CurseForge design.
- `specs/modpack-installation.md` — Phase 5 behavior and acceptance criteria.
- `implementation/phase5-modpack-sources.md` — owned paths, implementation steps, and pre-implementation gates.

- `research/` — immutable findings from Explorer workers (stack, UX, MC technical) + consolidated `sources.md`.
- `research/2026-10-08-phase2-process-safety.md` — sources and decisions for the active process-manager review rework.
- `research/2026-10-08-phase2-create-flow.md` — first-server Create view lifecycle follow-up.
- `research/2026-10-08-phase2-list-error.md` — retryable Tauri server-list load error state.
- `research/2026-10-08-phase3-java-provisioning.md` — Java requirements, Adoptium downloads, Windows runtime discovery, and resume/disk-space constraints.
- `research/2026-10-08-phase4-server-installs.md` — Mojang, Paper, Fabric, Quilt, Forge, and NeoForge metadata, installer behavior, integrity, cancellation, and publication findings.
- `research/2026-10-08-tauri-cli-setup.md` — official Tauri CLI installation guidance and the project’s current npm/Vite setup.
- `research/2026-10-09-post-validation-access-denied.md` — live Vanilla install evidence and Windows rename probe for the post-validation access-denied failure.
- `research/2026-10-09-quilt-installer-checksum.md` — Quilt Meta and Maven checksum comparison for the Quilt 0.15.1 installer.
- `research/2026-10-09-new-server-improvements.md` — restored New Server context, dynamic Mojang release catalogue, Java 25 scope, Quilt removal boundary, and UI findings.
- `research/2026-10-09-rustfmt-gate.md` — formatter-only Test-phase follow-up and verification plan.
- `architecture/` — system overview + ADRs (stack decision, scope).
- `architecture/adr/0004-server-installation-jobs.md` — staged, cancellable installer jobs and publish-after-validation behavior.
- `architecture/adr/0005-dynamic-releases-and-quilt-removal.md` — official release discovery, current Java runtime scope, and retired new-server Quilt creation.
- `specs/` — feature spec: tabs, UI elements, create-flow.
- `specs/minecraft-style.md` — Minecraft-look reskin spec (palette, font, recipes, IP red lines).
- `specs/java-provisioning.md` — server Java selection, installation, override, and validation behavior.
- `specs/server-installs.md` — provider discovery, loader compatibility, safe installation, cancellation, and Create UI acceptance criteria.
- `specs/new-server-improvements.md` — current New Server navigation, layout, release, Java, and loader acceptance criteria.
- `implementation/` — concrete plan + checklist for Implementer (Electron + TypeScript + React).
- `implementation/java-provisioning.md` — ordered backend/frontend implementation guide for Phase 3.
- `implementation/phase4-server-installs.md` — owned paths, ordered Phase 4 work, constraints, and verification checklist.
- `implementation/new-server-improvements.md` — active owned paths, implementation order, and checklist for the current follow-up.
- `implementation/tauri-cli-setup.md` — project-local CLI setup and desktop launch verification steps.
- `implementation/post-validation-publication.md` — scoped fix and regression plan for moving a validated staged server into its final folder.
- `implementation/quilt-installer-checksum.md` — historical checksum handoff for the retired Quilt server-creation path.

Stack decision: Electron + TypeScript + React (Vite) + Tailwind (ADR-0020 supersedes the Tauri stack in
ADR-0002 for the shipped app; the Rust tree is dormant reference). The framework-neutral HTTP backend
contract (ADR-0019) remains an optional browser deployment target.
Scope: modpack sources, console, players, worlds/backups/metrics/content/settings. Deferred: full files
browser, schedules beyond backups, roles, RCON (ADR-0011).
Current status/plan: `docs/electron-completion-plan.md`; verification: `docs/verification.md`; audit evidence:
`docs/audit/`.

The Phase 4 guide and Quilt checksum guide are historical records for retired new-server Quilt creation; see the active follow-up spec and guide above.
