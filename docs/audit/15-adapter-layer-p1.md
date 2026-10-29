# P1 — universal pack adapter layer (phase complete)

- Date: 2026-10-29
- Implements phase **P1** of [2026-10-29-universal-modpack-install.md](../research/2026-10-29-universal-modpack-install.md).
- Goal: stop fixing individual packs. Accept a **format**, normalize it to one canonical recipe, and let
  the existing install pipeline stay format-agnostic.
- Result: adapter layer landed, **FTB adapter live-verified against the real public API on 5 packs**,
  `npm run verify` **10/10 PASS**, unit **283/283**.

## What was built

| File | Purpose |
|---|---|
| `electron/services/adapters/types.ts` | `PackAdapter` / `PackRecipe` / `ArchiveIndex` contracts, canonical `FileSide` (**with `unknown` as a first-class value**), `MANAGER_OWNED_PATHS`, shared `isSafeRelativePath` / `normalizePath` |
| `electron/services/adapters/registry.ts` | `buildArchiveIndex` (one zip listing, memoized reads), `AdapterRegistry` (priority-ordered, first validated match wins, a throwing detector cannot break others), `validateRecipe` (the structural contract every adapter must satisfy) |
| `electron/services/adapters/ftb.ts` | FTB adapter: local App-instance detection from `instance.json`, remote resolution via the public API, pure mapping functions |
| `electron/services/adapters/index.ts` | Registry singleton, production `AdapterIo` (one allow-listed fetch helper + installer-log logging) |
| `electron/test/unit/adapters.test.ts` | 17 tests: registry semantics, recipe validation, and every FTB mapping rule |
| `scripts/verify-adapter-ftb.mjs` | Live harness: runs the adapter against the real API, validates the recipe, downloads and hash-verifies one file, writes `docs/evidence/adapters/ftb-pack-<id>.json` |

### Why FTB first

It is the format this app **could not open at all**, it needs **no API key** (unlike CurseForge, whose CDN
returns 403 unauthenticated), and it carries exact metadata. It is therefore the cheapest honest proof that
the adapter architecture generalizes beyond Modrinth/CurseForge.

## Live results (real API, no key)

`node scripts/verify-adapter-ftb.mjs <packId>` — evidence in `docs/evidence/adapters/`:

| Pack | Loader | MC | Java | Files resolved | Server-installable | Download check |
|---|---|---|---|---|---|---|
| FTB Academy 1.12 (1) | forge 14.23.5.2846 | 1.12.2 | 8 | 1,480 (59 client-only skipped) | 1,421 | HTTP 200, SHA-1 match |
| FTB Presents Stoneblock 2 (4) | forge 14.23.5.2847 | 1.12.2 | 8 | 1,432 | 1,432 | HTTP 200, SHA-1 match |
| FTB Interactions (5) | forge 14.23.5.2847 | 1.12.2 | 8 | 3,482 | 3,482 | HTTP 200, SHA-1 match |
| FTB Omnia (6) | **forge (inferred)** | 1.15.2 | 8 | 326 (2 client-only) | 324 | HTTP 200, SHA-1 match |
| FTB Sky Odyssey (8) | forge 14.23.5.2847 | 1.12.2 | 8 | 1,733 (1 client-only) | 1,732 | HTTP 200, SHA-1 match |

Every recipe passed `validateRecipe` (the same gate the pipeline will enforce) and every sampled download
returned HTTP 200 with a matching SHA-1 and size — with no authentication of any kind.

## Two real bugs the live run found (and fixed)

Both were invisible to the fixtures and only appeared against real FTB data. This is exactly why the phase
was verified live rather than by unit tests alone.

1. **FTB Omnia's mods were silently dropped.** The API is inconsistent between packs: most put the full path
   in `path` (`./mods/foo.jar`), but FTB Omnia puts **only the directory** in `path` (`./mods`) and the real
   filename in `name` (`Bookshelf-1.15.2-5.3.9.jar`). Using `path` alone yielded **0 mods** and made a
   155-mod Forge pack look like a vanilla 1.15.2 server.
   Fix: `resolveFtbDestPath()` completes a directory-like `path` with `name`.

2. **A pack with mods but no declared modloader was reported as `vanilla`.** FTB Omnia's `targets` contain
   only `minecraft` and `java` — no `modloader` target at all — while shipping 155 Forge jars. Installing
   that as vanilla would fail at boot with no explanation.
   Fix: `inferFtbLoaderFromFiles()` looks for `-forge-` / `-neoforge-` / `-fabric-` / `-quilt-` tokens in jar
   names, requires **a clear winner** (≥3 jars and no rival above half), records the inference in
   `resolution`, emits a `ftb.modloader-missing-inferred` warning, and **fails closed** when the evidence is
   absent or contradictory (`"ships mods but declares no modloader … refusing to install it as vanilla"`).

## Design guarantees this phase establishes

- **`unknown` is first-class.** A format with no per-file side data (CurseForge) must not collapse into
  `unsupported`; adapters that genuinely cannot decide leave `unknown` and the pipeline decides later.
- **Detection is by content, never extension.** `manifest.json`/`instance.json` are claimed by several
  formats, so `detect()` must validate keys. FTB's local detector requires numeric `id` **and** `versionId`
  plus a `mcVersion`.
- **Fails closed with evidence.** An unrecognized archive reports the entry count and root files it saw, so
  "unsupported" is diagnosable instead of a dead end.
- **Structural contract.** `validateRecipe` rejects empty/guessed MC versions, unsafe paths, sourceless
  files, `client-overrides` on a server install, and hybrid loaders — so a broken adapter fails at the
  boundary, not mid-install.
- **Every decision is attributable.** Files carry `sideProvenance`; recipes carry `resolution` steps and
  rule-id'd `warnings`.

## What P1 does NOT do (deliberately)

- **The pipeline is not yet wired to the adapter layer.** `PipelineSourceRequest` still has its four
  provider kinds; the adapters exist and are proven, but routing an FTB pack through
  preview → install → verified boot is **P1b** (next step). Until then this is a verified capability, not a
  shipped feature.
- No UI surface for FTB (no browse tab, no source picker entry).
- The remaining formats (packwiz, Prism, ATLauncher, GDLauncher, Technic, MCBBS, HMCL, plain server zip,
  nested/wrapper normalization) are P1c onward, in priority order from the research catalogue.

## Next steps

| Step | Work | Proof |
|---|---|---|
| **P1b** | Wire adapters into `PipelineSourceRequest` + preview/install so an FTB pack installs end-to-end; `AppError` mapping; keep the 4 existing kinds on the same path | FTB Academy or Stoneblock 2 installed through the real pipeline to `Done (` with the same verified-boot flow |
| **P1c** | Add packwiz + Prism + ATLauncher + plain-server-zip adapters (archive-based, fixture-testable) | T0/T1 fixture corpus detects each format and mis-detects none |
| **P2** | Side-resolution rewrite (SPC platform-dependency rule, dependency rescue, anchored matching, rule ids) | 12-pack matrix stays 12/12 + synthetic client-mod fixture excluded pre-boot |
| **P3** | Loader launch contract (`@unix_args.txt`, ServerStarterJar) | fixture tree with `libraries/`+`unix_args.txt`, no `run.bat`, boots |
| **P5** | Persisted file manifest + diff reinstall (unlocks the reference's update flow) | second install is a no-op; hand-added files preserved; world untouched |
