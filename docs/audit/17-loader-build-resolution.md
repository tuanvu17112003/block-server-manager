# Loader-build resolution and boot-decided escalation

- Date: 2026-10-29
- Completes the open defect from [16-adapter-pipeline-p1b.md](16-adapter-pipeline-p1b.md) §"The one open
  defect: unverifiable loader build".
- Result: **root cause found (and it was not what the first diagnosis said)**, fixed; escalation policy
  implemented, bounded and evidence-gated; **FTB Omnia now installs and verifies**; unit **301/301**,
  `npm run verify` **10/10 PASS**.

---

## 1. Analysis: the first diagnosis was wrong

Doc 16 recorded the Omnia failure as *"the pack declares no loader build, so we cannot know which Forge
build its mods were built against"*. That framing was wrong, and the wrong framing would have justified
building an expensive boot loop to work around a bug that had a one-line cause.

**The actual root cause: the FTB adapter picked the OLDEST version.**

`versions[]` from `api.modpacks.ch` is in **ascending** order (oldest first), and `id` is ascending too — id
order and `updated` order agree exactly, verified across five packs. `pickFtbVersion` returned `versions[0]`,
i.e. the *oldest* build:

| Pack | What the app picked (before) | What it should install |
|---|---|---|
| FTB Omnia | `v6` 1.0.0 **beta**, 2020-04-01, **no modloader at all** | `v91` **1.7.0 release**, 2020-07-29, **forge 31.2.33** |
| FTB Academy | `v2` 1.1.0 | `v158` 1.4.0 |
| Stoneblock 2 | `v94` 1.20.0 | `v12182` 1.23.0 |

So Omnia did not have silent metadata at all: **every one of its seven release versions declares Forge**.
Only the oldest beta lacked it. The "missing modloader" was entirely self-inflicted.

The same bug meant two packages that previously reported PASS were installing **outdated releases** — a
correctness defect that no test had caught, because both old and new builds boot.

**Fix** (`pickFtbVersion`): sort by `updated` (falling back to `id`) instead of trusting array order, prefer
the newest **release**, fall back to newest-of-any-type only when no release exists, and log when a
pre-release is used. Verified: all ten FTB packs now resolve a declared loader build.

## 2. Why escalation is still worth building (and what shape it should take)

After the version fix, **zero** of the ten surveyed FTB packs need escalation. But `loaderVersion: null`
remains a legitimate state for other formats (packwiz `[versions]`, ATLauncher without `loaderVersion`, bare
server zips), so the capability is still needed. The question is what shape.

The three options considered in doc 16, judged against the research:

| Option | Verdict |
|---|---|
| 1. Infer the build from `mods.toml` version ranges | **Rejected.** Ranges are frequently absent, and intersecting hundreds of them is both expensive and usually ambiguous. No surveyed tool does this. |
| 2. Refuse explicitly | Correct but gives up. Kept as the *fallback*, now with a precise reason. |
| 3. Bounded boot-decided escalation | **Adopted**, following ServerPackCreator's "the console decides" philosophy — but gated so it cannot paper over real pack defects. |

## 3. The escalation policy (what makes it safe)

Implemented in `electron/services/installer/loader-build.ts`, wired into the pipeline's `bootCheck`.

**Rule 1 — a declared build is authoritative.** If the pack states a build, it is used and can never be
overridden or escalated, even on a loader-level failure. `maxEscalations = 0`.

**Rule 2 — candidates come from the provider's own feed, recommended first.**
Forge's `promotions_slim.json` publishes `recommended` and `latest` per MC line. Verified real values:
`1.12.2 → recommended 14.23.5.2859 / latest 14.23.5.2864`; `1.15.2 → 31.2.57 / 31.2.62`. Ordering is
`recommended → latest`, deduped. NeoForge has **no equivalent feed** (only a flat version list with no MC-line
mapping), so NeoForge packs still require a declared build — stated honestly rather than faked.

**Rule 3 — only a *loader-level* failure may escalate, and mod-level evidence vetoes it.**
This is the critical gate. A mixin crash prints loader frames too, so naive pattern matching would escalate a
build for a pack that is simply broken. Classification therefore checks **mod-level signatures first**:

| Class | Example signature | Escalates? |
|---|---|---|
| `mod` | `Mixin apply failed`, `Missing or unsupported mandatory dependencies`, `---- Minecraft Crash Report ----`, duplicate mods, registry failure | **never** |
| `loader` | `Could not find main class cpw.mods.bootstraplauncher…`, `TransformationServicesHandler`, `MixinTransformationService`, `UnsupportedClassVersionError`, `legacyClassPath`, `@unix_args.txt`, module-path errors | yes, within budget |
| `unknown` | anything unrecognized | never |

The FTB Omnia failure signature from doc 16 (`MixinTransformationService` / `TransformationServicesHandler`)
is captured as a live regression test.

**Rule 4 — hard budget.** At most `candidates.length - 1` escalations (1 in practice). No loops, no
unbounded retries.

**Rule 5 — refuse out loud.** When no escalation happens, the report says exactly why, via
`explainNoEscalation`: *"the pack declares this exact loader build…"* / *"a mod failed (mod.mixin-apply),
which a loader change cannot fix"* / *"the failure does not identify the loader as the cause"* / *"no further
loader builds are available"*.

**Rule 6 — re-resolve the launch shape after reinstalling.** A loader artifact's filename contains its build
(`forge-1.12.2-<build>.jar`), so the launch command computed before the reinstall points at a deleted file.
Caught during review of my own implementation and fixed: the retry re-runs `validateStagedInstall`.

## 4. Live evidence

| Harness | Scenario | Result |
|---|---|---|
| `verify-adapter-ftb.mjs` (×10 packs) | resolve with corrected version selection | all ten pick the **newest release** with a declared build (Omnia: `v91 1.7.0`, forge 31.2.33) |
| `verify-ftb-install.mjs 6` | **full install of FTB Omnia** (previously failed at boot) | **PASS** — 369 files, `verify-boot: complete (first boot)`, publish complete, used declared build 31.2.33, **0 escalations** (187s) |
| `verify-ftb-install.mjs 4` | Stoneblock 2 on the corrected newest release | **PASS** — 1413 files, Done on first boot (418s) |
| `verify-ftb-install.mjs 1` | FTB Academy on the corrected newest release | **PASS** — 1503 files, Done on first boot, declared build 14.23.5.2847 (447s) |
| `verify-loader-escalation.mjs 1.12.2 forge` | plan with **no declared build**, real install + real boot | plan `14.23.5.2859 → 14.23.5.2864`, recommended build booted, 0 escalations needed |
| `verify-loader-escalation.mjs 1.15.2 forge` | same on the Omnia MC line | plan `31.2.57 → 31.2.62`, recommended build booted |

Evidence files: `docs/evidence/adapters/ftb-install-pack-{1,4,6}.json`,
`docs/evidence/adapters/loader-escalation-forge-{1.12.2,1.15.2}.json`.

Honest note: in these live runs the `recommended` build booted on the first try, so the **escalation branch
itself did not fire**. Its behaviour is covered by 12 unit tests (classification, planning, budget, veto,
refusal reasons) rather than by a live forced failure — forcing one would require deliberately corrupting a
working loader, which proves nothing about production packs. This is stated rather than implied.

## 5. Files

| File | Change |
|---|---|
| `electron/services/adapters/ftb.ts` | `pickFtbVersion` recency fix (+ `isFtbPrerelease`), used by the resolve path |
| `electron/services/installer/loader-build.ts` | **new** — classification, planning, escalation decision, refusal reasons |
| `electron/services/pipeline.ts` | computes a `LoaderBuildPlan` for forge/neoforge recipes, wires escalation into `bootCheck`, re-resolves the launch shape, records warnings, adds `fetchPromotions` |
| `electron/test/unit/loader-build.test.ts` | **new** — 12 tests |
| `electron/test/unit/adapters.test.ts` | version-selection regression test rewritten around the real ascending array |
| `scripts/verify-loader-escalation.mjs` | **new** — live proof the plan resolves and the recommended build boots |

## 6. Remaining honest limits

- **NeoForge has no recommended/latest feed**, so a NeoForge pack that declares no build still fails closed
  with a clear reason. Adding escalation there would require inventing an ordering; not done.
- **Rule 3 is a heuristic.** A loader failure whose output matches none of the known signatures classifies as
  `unknown` and does not escalate — deliberately conservative. New signatures are added as rows in the table,
  which is the same "data, not code paths" approach ServerPackCreator uses for its rule ladder.
- Escalation changes the loader build, which can itself break a pack that only works on an older build. That is
  why it is limited to packs that declare nothing (there is no declared answer to contradict) and to
  loader-level failures only.

## 7. Reproduction

```powershell
npm run build:electron
node scripts/verify-adapter-ftb.mjs 6                  # version selection only
node scripts/verify-ftb-install.mjs 6                  # full install + verified boot (~3 min)
node scripts/verify-loader-escalation.mjs 1.15.2 forge # plan + real boot on a no-declared-build scenario
```
