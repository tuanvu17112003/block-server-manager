# ADR-0007: Full Version Catalogue (All Installable Provider Builds)

- Status: Accepted
- Date: 2026-10-09
- Supersedes: the STABLE-only / promotions-only / releases-only catalogue limits in the Phase 4 spec and §5 of `docs/research/2026-10-08-phase4-server-installs.md`
- Research: `docs/research/2026-10-09-full-version-catalogue.md`

## Context

Each supported provider marks a recommended subset (Paper `STABLE` channel, Fabric `stable` flag, Forge `recommended`/`latest` promotions, Mojang `release` type), and the app treated those markers as installability gates. Live verification shows every marker is advisory: Paper BETA/ALPHA builds ship complete server jars; Fabric `stable:false` loaders serve identical metadata and `/server/jar` binaries; Forge's promotions map lags a full official build catalogue on the same host; Mojang snapshots expose `downloads.server` with the release shape. Users on valid non-stable builds (e.g. the Prominence II Fabric pin that motivated backend-005) were rejected despite the provider serving them.

## Decision

- List **all provider-published installable builds**, gated on **artifact completeness** (URL + size + hash present, trusted host) rather than the advisory flag.
- Catalogue sources: Paper Fill builds array (any `channel`); Fabric Meta loader list (any `stable`) + exact endpoint at install; Forge `maven-metadata.json` per-MC list (exact-membership validation); NeoForge Maven metadata with the documented prefix table (extended only by documented mapping); Mojang manifest `release` + `snapshot` types (`old_*` stays excluded).
- Order stable/recommended first; label every non-stable row inline (`STABLE`/`BETA`/`ALPHA`, `stable`/`non-stable`, `recommended`/`latest`/`specific version`, `release`/`snapshot`).
- Stable-by-default with a persistent "Show all builds" opt-in (Vanilla snapshots) / expanded labelled loader lists; never silently substitute a stale selection — hold it, explain, block Install until the user picks.
- Exact-verify the selected build at install, revalidation, and publication with no substitution; fail closed on malformed/unsupported/unavailable metadata.
- Keep all existing safety: provider HTTPS allowlists, hash/size checks, staging/rollback, EULA explicitness, cancellable jobs, CurseForge-disabled gate, no new dependencies without consent.

## Consequences

- Version/loader lists grow (Forge: ≤2 → up to 355 entries per MC); UI must keep stable-first ordering and the advanced toggle to avoid overwhelming default users.
- Extra catalogue fetch for Forge (`maven-metadata.json` alongside `promotions_slim.json`); failure of either fails the Forge section closed, never silently.
- Paper whole-version gate (`resolve_paper_versions`) now admits MC versions whose builds are all non-STABLE, as long as one is artifact-complete.
- Vanilla snapshot installs reuse the existing artifact path unchanged; snapshots without `downloads.server` (none observed in modern lines) fail with the existing clear error.
- The Phase 4 spec's STABLE-only / promotions-only / releases-only statements are superseded for catalogue scope; safety and verification statements stand.
