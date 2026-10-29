# P1b — adapter layer wired into the pipeline (FTB installs end-to-end)

- Date: 2026-10-29
- Continues [15-adapter-layer-p1.md](15-adapter-layer-p1.md). P1 built the adapters; P1b makes them a
  shipped feature: a format the app could not install at all now goes through the **real** pipeline
  (preview → staged download → loader → verified boot → atomic publish).
- Result: **2/2 real FTB packs install and verify end-to-end**, unit **289/289**, `npm run verify`
  **10/10 PASS**.

## What changed

| Area | Change |
|---|---|
| `PipelineSourceRequest` | two format-agnostic kinds: `{ kind: 'ftbProject', packId, versionId? }` and `{ kind: 'packArchive', sourceId }` |
| `HeldPreview` | carries the canonical `recipe` from preview through install, so one path serves every adapter format |
| `previewInner` | new branch: build an `ArchiveIndex` (archives) or provider context (FTB), resolve through `adapterRegistry`, then run the **same** L1/curated decision mapping the Modrinth path uses |
| `installInner` | new branch: `installRecipe(...)` → loader + hash-verified files, then the existing staged transaction, L2/L3 boot verification and publish |
| `assertInstallableSource` | recipe path validates exact MC + loader and applies the new-install loader policy |
| `validate-ipc.ts` | `ftbProject` / `packArchive` argument validation (int ids / path string) |
| `electron/services/installer/recipe.ts` | **new** — the format-agnostic installer: loader install, side-aware file planning, hash/size-verified downloads, manager-state protection |
| `scripts/verify-ftb-install.mjs` | **new** — end-to-end live harness |
| `electron/test/unit/recipe-install.test.ts` | **new** — 5 planning-rule tests |

## Live end-to-end results

`node scripts/verify-ftb-install.mjs <packId>` — full pipeline, real downloads, real boot, real publish.
Evidence: `docs/evidence/adapters/ftb-install-pack-<id>.json`.

| Pack | Preview | Installed | Stages | Verdict |
|---|---|---|---|---|
| **FTB Presents Stoneblock 2** (4) | forge 1.12.2, 1426 include / 6 conflicts | **1426 files** | download → validate → **verify-boot: complete (first boot)** → publish complete | **PASS** (571.8s) |
| **FTB Academy 1.12** (1) | forge 1.12.2, 1415 include / 59 exclude / 5 conflicts | **1415 files** | download → validate → **verify-boot: complete (first boot)** → publish complete | **PASS** (488.5s) |

Both reached `Done (` on the **first** boot, so no auto-fix rounds were needed for either pack. Both
published atomically through the same transaction that Modrinth/CurseForge installs use.

Note on FTB Academy: 59 files were excluded **at preview** by the canonical side resolution (FTB declares
`clientonly`), and 64 at install after explicit conflict resolution — the adapter's declared sides and the
curated layer worked together, exactly as designed.

## Three more real bugs found by running it (all fixed)

P1 fixed two bugs found by *resolving*; P1b found three more by *installing*. None were visible in
fixtures.

1. **A legitimately empty file was rejected.** FTB Stoneblock 2 ships three zero-byte config files
   (`chiselsandbits_clipboard.cfg`, `friends.cfg`, `bookmarks.ini`), each with the SHA-1 of the empty
   string (`da39a3ee…`) and `size: 0` — correct, verifiable, real content. The installer's "empty file
   means we got an HTML error page" guard aborted the whole install at file 1 of 1432.
   Fix: reject a zero-byte result **only when the recipe declared bytes** (`size > 0`); hash verification
   already catches content lies.

2. **An extensionless filename was mistaken for a directory.** Stoneblock ships
   `path: "./config/vanillafix"` (a directory) with `name: "config_version"` (a file, **no extension**).
   The heuristic "path has a dot ⇒ it is a file" treated the directory as a file, wrote it, and a later
   `mkdir` for the real child path failed with `EEXIST: … config\vanillafix`.
   Fix: stop guessing from extensions. `name` is always the file name and `path` is either the full path or
   its parent directory, so use `path` when it ends with `name`, otherwise join them.

3. **A pack with no declared Forge build was installed with whatever Forge was newest.** FTB Omnia (pack 6)
   declares only `minecraft` + `java` targets — no modloader version (and no modloader at all, which the P1
   inference handles). Installing Forge *latest* for 1.15.2 produced a mixin/service crash at boot
   (`MixinTransformationService` / `TransformationServicesHandler`) and the install failed correctly rather
   than publishing a broken server. **This one is not yet fixed** — see below.

## The one open defect: unverifiable loader build

FTB Omnia cannot be installed reliably today, and the reason is legitimate metadata failure rather than a
code bug: the pack declares no loader version, so we cannot know which Forge build its 155 mods were built
against, and no inference from jar names can recover a *version*. The install fails closed (good) instead of
publishing a server that crashes on boot (also correct behaviour).

Options, in order of correctness:

1. **Resolve the version from the mods themselves** — read the mod jars' `mods.toml`/`MANIFEST` for a
   required Forge range and pick the matching promotion. Expensive and often ambiguous.
2. **Refuse the pack explicitly with an actionable message** — "this pack does not declare a loader build;
   install it via a source that does (or pin one manually)". Honest, cheap, and correct today.
3. **Try, and let the boot loop tell us** — bounded attempts across the newest few Forge builds for that MC
   line, stopping at the first that reaches `Done (`. This is the SPC "the console decides" approach and is
   the only one that can actually succeed for packs like Omnia.

Current behaviour is (2) in effect — it fails at boot with a clear error. Option 3 is the natural next
increment and belongs with P3 (loader launch contract), because both concern getting the loader
runtime exactly right.

## What P1b establishes

- **One install path for every format.** After an adapter returns a recipe, nothing downstream knows or
  cares which launcher produced the pack. Adding packwiz/Prism/ATLauncher (P1c) needs no pipeline change.
- **The defense stack still applies to adapter installs.** `autoFixContext` is populated for recipes too, so
  L2 jar-scan and L3 boot-decides auto-fix run on FTB packs exactly as on Modrinth packs.
- **Ads are honoured, not trusted.** FTB `clientonly` produced 59 preview exclusions on FTB Academy; the
  boot verification then confirmed the remaining set boots.
- **Manager state is protected.** `planRecipeFiles` never installs `eula.txt`, `server.properties`,
  `ops.json`, etc. from a pack, regardless of what an adapter claims.
- **`unknown` is preserved end-to-end.** It resolves to a normal server candidate at preview and is only
  ever removed by evidence (curated rule, jar scan, or boot), never by silence.

## Remaining gaps after P1b

| Gap | Status |
|---|---|
| FTB packs that declare no loader build (e.g. Omnia) | fails closed with a clear error; needs P3 (boot-decided loader build) |
| UI surface for FTB / archives | none yet — only IPC/pipeline support |
| `packArchive` adapter coverage | only FTB detects archives today; P1c adds packwiz/Prism/ATLauncher/plain-zip |
| Persisted file manifest for diff-based reinstall (P5) | still absent; the sidecar records a file list but is not yet diffable |
| Adapter installs get no dependency fetch during L3 | `fetchDependency: null` for recipes (correct for now: FTB files are fully enumerated) |

## Reproduction

```powershell
npm run build:electron
node scripts/verify-adapter-ftb.mjs 4        # resolve only (fast, no install)
node scripts/verify-ftb-install.mjs 4        # full install + verified boot (~10 min)
```
