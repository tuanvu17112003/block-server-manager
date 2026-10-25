# Implementation Guide — Full Version Catalogue (backend-006)

Read first: `docs/research/2026-10-09-full-version-catalogue.md`, `docs/architecture/adr/0007-full-version-catalogue.md`, `docs/specs/server-installs.md` (Discovery + Acceptance sections), and the Scout-reported UI insertion points in `src/tabs/Create.tsx`.

## Pre-implementation gates

- No new Rust dependencies without explicit user consent. No CurseForge commands, key UI, or keyring.
- Preserve: provider HTTPS allowlists + per-hop redirect policy, hash/size verification, staging/rollback, cancellable jobs, explicit EULA, `modrinth:` exact-build behavior from backend-005, Quilt-creation rejection with saved-Quilt support.
- Line numbers below are Scout-reported against the current `installer/mod.rs`; confirm before editing (CodeGraph first per `AGENTS.md`).

## Owned paths

- Backend: `src-tauri/src/installer/mod.rs` (only). If the NeoForge prefix table must change, `src-tauri/src/servers/process.rs` launch-side table is a **read-only** reference — do not edit it in this task; stop and report instead.
- Frontend: `src/tabs/Create.tsx`, narrowly required `src/tauri.ts` DTO additions. Browser mocks (`src/mocks/`) may gain labelled entries only if needed for the toggle; no mock-success paths under Tauri.
- Forbidden: new commands, command renames, dependency changes, CurseForge, unrelated tabs, standalone safety semantics.

## Ordered steps

### A. Backend catalogue (all in `src-tauri/src/installer/mod.rs`)

1. **Mojang types** — `vanilla_manifest_entries` (~1472): keep `release` + `snapshot`, keep excluding `old_alpha`/`old_beta`. `versionType` already flows through `MinecraftVersion` → DTO; no shape change.
2. **Vanilla list** — `resolve_vanilla_versions` (~1298): return releases + snapshots (UI filters client-side via `versionType`; no command-signature change). `versions_vanilla` command (~310) unchanged.
3. **Release gate relaxation** — every `version_type == "release"` predicate that blocks a manifest-listed MC must accept snapshots: `resolve_loader_choices` (~1341-1348), Vanilla branch of `resolve_install_artifact` (~1507-1510), Modrinth Fabric MC check (~1685-1693). Artifact-absent entries still fail via the existing "no server download" error.
4. **Paper** — `paper_builds` (~1416): drop the `channel != STABLE → continue` filter; a build qualifies iff `downloads["server:default"]` has `url` + `size` + `sha256` on the trusted host (existing checks). Carry `channel` into `PaperBuild`; label `Paper {channel} build {id}` (STABLE wording stays for stable rows). Fail closed on the non-array `ok:false` envelope (existing). `resolve_paper_versions` (~1311): keep structure, now admits all-STABLE-less MCs with any artifact-complete build. Sort STABLE first.
5. **Fabric** — `resolve_loader_choices` Fabric section (~1364-1383): drop the `stable != true → continue` filter; label `Fabric Loader {version}` + ` (non-stable)` suffix when `stable != true`; sort stable first. `validate_fabric_loader` (~1719): replace the stable-requiring list scan with exact-endpoint resolution (same rule as the modpack path: HTTP 200 + `loader.version` match, any `stable`); keep fail-closed error. `latest_fabric_installer` stays latest-stable pin.
6. **Forge** — add a catalogue fetch for `https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json` (same host family as promotions; reuse `fetch_json` + cancellable control). `resolve_loader_choices` Forge section (~1385-1398): offer `recommended`/`latest` entries labelled as today, plus every other per-MC catalogue entry labelled `Forge {build} (specific version)`; stable/promoted first. `resolve_install_artifact` Forge branch (~1584): validate **exact catalogue membership** before URL construction (never reassemble parts). Either catalogue-source failure fails the Forge section closed.
7. **NeoForge** — `neoforge_versions` already enumerates all metadata entries: add a beta label (`{version} (beta)` when the version segment contains `beta`, case-insensitive) and sort non-beta first. Do NOT extend `neoforge_prefix` (nor the `process.rs` twin) beyond documented mappings in this task; report gaps instead.
8. **Stability signal for the UI** — extend `LoaderChoice`/`LoaderChoiceDto` with an additive optional field (e.g. `stable: boolean | null`, `None`/`null` = not applicable such as Vanilla) so the toggle filters machine-readably instead of parsing labels. Existing `label` strings gain the human-readable suffixes above. This is the only DTO change; mocks typecheck must still pass.

### B. Frontend (`src/tabs/Create.tsx`, `src/tauri.ts`)

9. **Vanilla snapshots** — add `showSnapshots` state (default `false`); client filter `configureVersions.filter(v => showSnapshots || v.versionType === 'release')`; suffix non-release options (`{id} — Snapshot`); hint-line update; checkbox inside the Minecraft-version `Field`. Amend the reset effect so toggling off with a snapshot selected holds the selection, shows an explanatory notice, and lets the existing `beginInstall` guard block Install (mirror the loader-mismatch pattern; no silent jump to `[0]`).
10. **Loader toggle** — same pattern for `loaderChoices`: stable-by-default filter on the new `stable` field (`stable !== false`), "Show all builds" checkbox under the loader picker, non-stable rows show their labelled suffix, stale-selection hold-and-notify reuses the existing `loaderError` path.
11. **Modrinth scope (B11)** — out of scope: pack game-version options keep current behavior.
    Pack boundary: modpack installs stay releases-only; standalone snapshot catalogue support is unchanged.
    Enforced by the pack `release` gate (backend) and `versionType === 'release'` filter (frontend).

## Verification checklist

- Unit tests (existing `#[cfg(test)]` modules): Paper artifact-complete BETA/ALPHA accepted + incomplete skipped + non-array envelope rejected; Fabric `stable:false` listed and install-validated, wrong version rejected; Forge catalogue membership (promoted + specific accepted, forged string rejected); NeoForge beta labelled and installable; snapshot `versionType` flows and `old_*` excluded; stale-selection guards (no silent substitution).
- Regression: full `cargo test --lib` (shared `resolve_install_artifact` / `prepare_install_with_progress` paths), `cargo check --lib` (no new warnings), `cargo fmt --check`, `npx tsc --noEmit`.
- Review: independent check of allowlist/host handling for the new Forge catalogue URL, exact-membership validation, DTO back-compat, and toggle hold-and-notify behavior.
- Live-network smoke tests remain out of scope (offline unit tests only), recorded as a limitation as in prior phases.
