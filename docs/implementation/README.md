# Implementation

- `curseforge-cancel-aware-copy.md` — scoped owned paths, cancellation wiring, and independent review criteria for nested CurseForge ZIP revalidation.
- `framework-neutral-backend-api.md` — frontend transport adapter, runtime API config, browser uploads/events, and backend deployment gates.
- `modrinth-preview-ipc-casing.md` — scoped Serde/TypeScript request-casing fix, error surfacing, and reproduction gates.
- `server-pack-correctness.md` — bounded archive handling, Modrinth server file selection, Java metadata checks, and focused review checklist.
- `modrinth-runtime-and-fabric-metadata.md` — Modrinth Java selection, Fabric metadata preflight, override coverage, and regression checklist.
- `modrinth-missing-hard-dependencies.md` — bounded server dependency closure check, override/nested-mod handling, and regression checklist.

- `curseforge-server-pack-import.md` — CurseForge browser/download/import design, dependency gates, owned paths, and implementation checklist.
- `modpack-server-setup-overhaul.md` — current phased implementation plan for the unified modpack install pipeline.
- `console-log-performance.md` — implementation ownership, constraints, and verification checklist for console log performance.
- `server-initial-heap.md` — backend JVM heap arguments, constraints, and verification checklist.
- `backend-phase6-console.md` — backend-only Phase 6 owned paths, ordered steps, verification, and pre-implementation gate.

- `modrinth-all-pack-files.md` — backend-014 all-manifest-files installation policy, owned paths, and verification checklist.

- `phase5-modpack-sources.md` — Phase 5 Modrinth-first owned paths, ordered implementation guide, and API/dependency gates.
- `modpack-download-reliability-rework.md` — backend-008 hash-authenticated size reconciliation, four-worker download pool, and verification checklist.
- `modpack-download-source-failover.md` — backend-009 ordered candidate URLs, bounded retry rotation, and integrity/safety constraints.

- `plan.md` — frontend MVP plan (DONE).
- `backend-plan.md` — phased backend plan 0–10 (foundations → persistence → process → Java → installs → packs → console → players → worlds/backups → metrics → updater), IPC surface, data model, test strategy.
- `backend-plan.md` Phase 2 now includes the scoped review rework criteria; research and trade-offs are in `../research/2026-10-08-phase2-process-safety.md`.
- First-server Create completion behavior is specified in `../specs/app-tabs.md` and researched in `../research/2026-10-08-phase2-create-flow.md`.
- Tauri server-list loading and retryable error handling are described in `../research/2026-10-08-phase2-list-error.md`.
- `checklist.md` — acceptance for coder/reviewer.
- `java-provisioning.md` — Phase 3 owned paths, ordered implementation steps, boundaries, and verification criteria.
- `phase4-server-installs.md` — Phase 4 owned paths, provider integration, safe publication, cancellation, and verification criteria.
- `new-server-improvements.md` — current ordered handoff and checklist for New Server fixes, dynamic releases, Java 25, and Quilt removal.
- `tauri-cli-setup.md` — install the missing project-local Tauri CLI and verify the native desktop development launch.
- `post-validation-publication.md` — close the publication log handle before moving the staged install, with Windows regression coverage.
- `quilt-installer-checksum.md` — historical checksum handoff for the retired Quilt creation path.

`phase4-server-installs.md` and `quilt-installer-checksum.md` are historical records; their Quilt creation guidance is superseded by `new-server-improvements.md`.
