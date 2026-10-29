# 11 — CurseForge install path: same verified boot, plus a prebuilt-pack metadata fix

- Date: 2026-10-29
- Question answered: do the Prominence II fixes (see [10](10-prominence-modrinth-install-fix.md)) apply to
  CurseForge installs too? **Yes for the verified boot, N/A for the Modrinth choice logic, and the CF
  route had its own latent defect that this review found and fixed.**

## What carried over automatically

The install-time L2 (jar self-declaration scan) + L3 (`startWithAutoFix`) verified boot lives in
`pipeline.ts` → `install-transaction.bootCheck`, which is route-agnostic. Every CurseForge install with
`eulaAccepted && javaPath` now runs the same loop before publish, with the D9 difference preserved:

| Defense | Modrinth | CurseForge |
|---|---|---|
| L1 manifest env | yes | manifest `files[].required` + curated |
| L2 jar scan before first boot | yes | yes (same code) |
| L3 crash attribution + `mods-disabled/` | yes | yes (same code) |
| L3 dependency fetch | `fetchModrinthDependency` | **null — prune-only (D9)** |
| Learned disables appended | yes | yes |
| Verified boot inside transaction (rollback on failure) | yes | yes |

The Modrinth-specific fix does **not** apply to CF: CF has no per-file Include/Exclude plan, so
`resolveIncludedPaths` and `includeFiles`/`excludeFiles` remain Modrinth-only. CF pruning uses the CurseForge
`isClientOnly` game-version check plus the CurseForge curated list, which already match the reference.

## Defect found while verifying CF (fixed)

`inspectStagedZip` classified prebuilt packs as `supportedServerPack` but left `minecraftVersion` **null**
whenever the pack had no `manifest.json` and no `forge-*-installer.jar`. The pipeline correctly refuses to
publish blank metadata, so *runnable, complete* prebuilt packs were rejected with
"does not declare an exact Minecraft version and loader". Real cached packs affected: `936875-server-*`
(332 mods, `libraries/net/minecraftforge/forge/1.20.1-47.4.23/`) and `829758-server-*`.

Fix: `inspectStagedZip` now runs the existing `inferServerPackMetadata(names)` over the archive and fills
`minecraftVersion` / `loader` / `loaderVersion` from `libraries/` maven layout, a shipped installer name, or a
versioned server jar — never guessing when nothing is found.

## Evidence (real packs, real Java 17, real Pipeline, throwaway data roots)

| Pack | Route | Result |
|---|---|---|
| `936875-server-8853081.zip` (1.0 GB Forge 1.20.1-47.4.23 prebuilt, 332 jars) | A / prebuilt | `status=complete`; `verify-boot: complete (first boot)`; **327 jars + 5 L2-disabled** |
| `392141-server-6290699.zip` (281 MB SkyFactory 5, ships `forge-1.20.1-47.4.0-installer.jar`) | A / shipped installer executed | `status=complete`; `verify-boot: complete (first boot)`; **262 jars + 2 L2-disabled** |

Both installs logged `[L2] … → mods-disabled` entries (`appleskin`, `emi`, `emitrades`,
`BetterAdvancements`, `no-telemetry`, `ClearSky`), proving the shared L2 stage runs on the CurseForge route,
and both reached `Done (` inside the staged transaction and published.

- `node scripts/unit.mjs`: **263/263 pass** (2 new `inspectStagedZip` regression tests).
- `npm run verify`: **PASS 10/10**.
- Harnesses kept: `scripts/verify-cf-install.mjs` (CF), `scripts/verify-prominence-fix.mjs` (Modrinth).

## Notes / limits

- The CF L3 dependency-fetch hook is intentionally `null`: a CF pack's manifest already lists every required
  project file, so fetching a Modrinth project would inject unvetted jars into someone else's pack.
- `466901-server-*` still fails preview: it is a 2-entry stub archive with no mods/loader/installer, i.e. not a
  server pack at all — correct rejection, unchanged by this fix.
- `829758-server-*` has mods but no Forge/Fabric loader evidence in the archive (its `start.ps1` assumes an
  external runtime), so it still previews with blank metadata — a genuine "unknown pack shape", not a bug.
