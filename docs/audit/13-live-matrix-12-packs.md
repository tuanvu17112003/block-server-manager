# 13 — Live 12-pack acceptance matrix: app vs the reference sweep

- Date: 2026-10-29
- Question: run the reference's own 12-pack matrix through **this app** and check whether the Modrinth
  and CurseForge implementations match the design in `H:\TestAI\modrinth-curseforge`.
- Method: `node node_modules/electron/cli.js . --matrixtest` (`electron/matrix-test.ts`). Every pack goes
  through the real pipeline the wizard uses — `modpack_pipeline_preview` → reviewed file choices →
  `modpack_pipeline_install` (staged download, L2 jar scan, L3 auto-fix verified boot, atomic publish) —
  in its own throwaway data root, with real Java (auto-provisioned) and real network.
- Result: **12/12 PASS**, each with `verify-boot: complete` and a durable per-pack evidence file.

## Matrix result

See [`docs/evidence/matrix/README.md`](../evidence/matrix/README.md) (generated) and `_summary.json`.
Per-pack JSON holds the preview plan (include/exclude/conflict counts), the full report (stages + file
rows + warnings) and the published jar counts.

| Pack | Platform | Loader | Verified boot | Jars (enabled/disabled) | Reference |
|---|---|---|---|---|---|
| SkyBlock Enhanced | Modrinth | fabric 26.2 | complete | 13/2 | PASS `Done (2.044s)` |
| Cobbleverse | Modrinth | fabric 1.21.1 | complete | 100/14 | PASS `Done (9.670s)` |
| BattleArmory TACZ | Modrinth | forge 1.20.1 | complete | 60/20 | PASS `Done (8.638s)` |
| Prominence II (Modrinth) | Modrinth | fabric 1.20.1 | complete | 348/15 | PASS `Done (37.310s)` |
| Slimes Adventure RE | Modrinth | fabric 1.21.1 | complete | 115/4 | PASS `Done (11.502s)` |
| Zombie Invade 100 Days | Modrinth | forge 1.20.1 | complete | 97/21 | PASS `Done (21.694s)` |
| Dungeon Heroes | CurseForge | fabric 1.21.1 | complete | 187/0 | PASS `Done (50.984s)` |
| RLCraft | CurseForge | forge 1.12.2 (Java 8) | complete | 178/0 | PASS `Done (11.237s)` |
| SkyFactory 5 | CurseForge | forge 1.20.1 | complete | 262/2 | PASS `Done (7.231s)` |
| DawnCraft | CurseForge | forge 1.18.2 | complete | 249/2 | PASS `Done (71.137s)` |
| Otherworld D&D | CurseForge | forge 1.20.1 | complete | 356/0 | PASS `Done (44.789s)` |
| Prominence II (CurseForge) | CurseForge | fabric 1.20.1 | complete | 368/5 | PASS `Done (34.511s)` |

Loader/MC for all 12 match the reference's own table. Jar counts differ in the expected direction: the
reference counted `files[]` entries, this app also reports jars shipped inside the pack plus L2-disabled
jars separately (e.g. Prominence CF 368+5 vs "576 files" because the server pack bundles its mods and
the reference's number counted manifest entries).

## Bugs the matrix found and fixed (all generic, no per-pack branches)

The first full run scored **5/12**. Each failure was a real defect, not a pack quirk:

| # | Defect | Fix | Evidence |
|---|---|---|---|
| 1 | `--matrixtest` runs under an isolated Electron profile, so `safeStorage` could not decrypt the real CurseForge key and every key-mode pack failed with "API key required". | Harness seeds the key into each pack's own data root (the app's documented plaintext fallback path) and resets the per-process key cache. | RLCraft/Dungeon Heroes/Otherworld/DawnCraft/Prominence CF all reach the API |
| 2 | `inspectCurseForgeProject` rejected RLCraft because its **newest** file lists `gameVersions: ["1.12.2"]` with **no `Forge` tag** (publisher data defect). | When the newest file names no loader, read the project's recent files and use the loader the author tagged on files for the same MC version; if no sibling agrees, still fail closed. | RLCraft preview: `forge 1.12.2` via 2 sibling files |
| 3 | A **nested-ZIP** server pack (Prominence II CF: one `.zip` + `readme.txt`) was rejected — ADR-0013 requires supporting this wrapper. | `findNestedServerPackZip()` + unwrap in both `inspectStagedZip` and `installCurseforge`; the scratch inner file is deleted afterwards. | Prominence CF: `unwrapped nested server pack "Prominence…_server_pack.zip"` |
| 4 | ServerPackCreator packs ship their **own** `manifest.json` (a flat file list). Reading `minecraft.modLoaders` off it threw `TypeError: Cannot read properties of undefined`, aborting the install. | Only the real CurseForge schema (`minecraft.modLoaders` array) counts as a client export; anything else falls through to layout detection. | Prominence CF install proceeds past classification |
| 5 | A bare SPC archive (mods/ + config/, no loader evidence) failed closed even though the API already knew the loader/MC. | `InstallCfOpts.knownLoader/knownMc` from the preview feed the engine for archives with no metadata of their own. | Prominence CF: `using official-API metadata: fabric 1.20.1` |
| 6 | Forge packs with no pinned build threw "Forge needs an exact loader version" (RLCraft's server pack ships mods only). | Resolve the provider's canonical build from Forge's `promotions_slim.json` (recommended → latest). | RLCraft: `using provider build 14.23.5.2859 (recommended)` |
| 7 | Empty-string `loaderVersion` slipped past `??`, producing `forge installer not found for 1.12.2- (HTTP 404)`. | Test for a non-empty trimmed version. | RLCraft installs and boots |
| 8 | **DawnCraft installed the wrong loader**: CF lists `1.18.1, 1.18, Forge, 1.18.2, 1.18-Snapshot` for one file and the app took the *first* numeric tag (1.18.1) instead of the author target 1.18.2 → Forge died with `ClassNotFoundException: JarInJarDependencyLocator`. | `pickMinecraftVersion()` prefers the highest stable `x.y.z` (ignoring `*-Snapshot` markers). | DawnCraft: `forge 1.18.2`, boot OK, L3 disabled `itemphysic` |

Two further observations, recorded honestly:

- **Dungeon Heroes failed once mid-sweep with `Temurin download failed: terminated`** (network flake while
  provisioning Java 21) and passed on retry (117.8 s). Not a code defect; retry-safety is by design.
- **SkyFactory 5 install verification remains flaky** (separately documented in
  [11-curseforge-install-parity.md](11-curseforge-install-parity.md)): it passed in this sweep.

Regression tests added for defects 3, 4 and 8 (`electron/test/unit/curseforge.test.ts`):
`pickMinecraftVersion` tag sets, nested-ZIP unwrapping, and SPC-manifest fall-through.

## Gates

- `node scripts/unit.mjs`: **266/266 pass** (3 new).
- `npm run verify`: **PASS 10/10**.
- Harness: `electron/matrix-test.ts` (`--matrixtest`, `--only=<slugs>`, `--resume`), summariser
  `scripts/matrix-summary.mjs`, evidence under `docs/evidence/matrix/`.

## What this does and does not prove

Proves: this app's Modrinth **and** CurseForge install pipelines reproduce the reference's accepted
outcome (verified `Done (`) for all 12 matrix packs, with the same loaders/MC versions, on the real
providers, with L2/L3 doing the same work the spike did (e.g. Prominence CF: L2 disabled 4 self-declared
client jars, L3 then disabled `forgeconfigscreens` and booted).

Does not prove: the surrounding product contract matches the design docs — the divergences listed in
[12-reference-conformance-audit.md](12-reference-conformance-audit.md) §B (optional-mod default, keyless
opt-in gate, update flow, manual-required panel, L3 budget, learned-file read path, scripted-pack consent
flow, i18n/progress) are unaffected by this sweep and remain open.
