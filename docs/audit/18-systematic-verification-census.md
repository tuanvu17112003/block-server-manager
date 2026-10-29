# Systematic verification: why 7 bugs appeared, and the census that replaces trial and error

- Date: 2026-10-29
- Trigger: the operator's correction — *"nên nghiên cứu lại thật kỹ thay vì làm mù, nãy giờ tìm ra rất
  nhiều lỗi"*. That criticism was correct.
- Result: **7 bugs classified, 5 new failures found by a full-corpus census instead of by chance**, all fixed;
  unit **308/308**, `npm run verify` **10/10**, corpus conformance **87/92 packs pass, 0 hard failures**,
  FTB Omnia install still passes.

---

## 1. Honest accounting: the 7 bugs were not bad luck

Every bug found so far came from running one more pack by hand. That is a sampling strategy, and it is
biased: each fix revealed the next bug. Classified by root cause:

| # | Bug | Class | What upfront study would have predicted it |
|---|---|---|---|
| 1 | FTB Omnia's 155 mods dropped (`path` is a directory, `name` is the file) | **field-semantics assumption** | A field inventory over the corpus: what does `path` actually contain? |
| 2 | A directory treated as a file (`config/vanifallfix` + `config_version`) → EEXIST | **field-semantics assumption** | Same inventory, plus: can `name` lack an extension? |
| 3 | Legit zero-byte config files rejected | **value-space assumption** | Distribution of `size` — is `0` a valid value? |
| 4 | `versions[0]` was the OLDEST build, not newest | **ordering assumption** | Is `versions[]` sorted? Check `id` vs `updated` monotonicity. |
| 5 | A modded pack with no loader target read as vanilla | **precedence / contradiction** | Census: how many packs reject the loader? What are valid fallbacks? |
| 6 | Classifier missed legacy Forge's library error | **incomplete signature table** | Gather real failure output per loader era before writing the table. |
| 7 | Launch shape pointed at the old loader jar after escalation | **state invalidation** | Standard consequence analysis of "reinstall a component whose filename encodes its version". |

Six of the seven are *data-shape assumptions* — exactly what a corpus census finds in one pass. Zero needed
a guess; all needed a measurement I had not taken.

**The fix is not more careful guessing. It is measuring the whole corpus first.**

## 2. The census (measure before assuming)

`scripts/census-ftb-api.mjs` walks **every published FTB pack** (`/public/modpack/all` → 92 packs), pulls up
to two versions of each, and records value-spaces and hazards as data.

Scope: **92 packs, 149 versions, 157,125 files.**

### What it established

| Question | Measured answer | Consequence |
|---|---|---|
| Does `path` contain the filename? | **Never.** `path` is the parent directory in **157,125 / 157,125** files; `name` was never empty | `path + '/' + name` is the only correct rule. Both earlier heuristics were wrong. |
| Is `versions[]` sorted? | **Ascending by id in 58/58 packs**; `updated` agrees with `id` in **46/58** | Never trust array order; sort by `updated`, then prefer `release`. |
| Can "newest by updated" differ from "newest by id"? | **Yes, 1 pack** (`FTB Chocolate` 94: `updated` picks 1.0.0, `id` picks 1.1.0) | Sorting by `updated` is right, but the difference is real and must be a decision, not luck. |
| Are duplicate destinations possible? | **Yes — 22 across the corpus** (e.g. `mods/pedestals-0.4.56.jar` twice in one version) | Dedupe explicitly; first entry wins; report it. |
| Are file-vs-directory collisions possible? | **0** after the correct `path+name` rule | Worth asserting in conformance, not fixing. |
| Unsafe paths (`..`)? | **0** in the corpus | Keep the guard; it never fires on real data but must exist. |
| Zero-byte files? | **290** | `size: 0` is normal, never treat as an error. |
| Which MC versions exist? | 22 distinct, incl. `18w43b`, `26.3-pre-1`, `26.4-snapshot-6`, `rd-132211`, `c0.0.11a` | The recipe validator's `\d+\.\d+(\.\d+)?` would **refuse real packs**. |
| Which Java majors do packs declare? | 8 (67), 17 (20), 21 (3), **11 (1)** | Java 11 is declared but unprovisionable; must round up, not drop. |
| Loader distribution | forge 80, neoforge 6, fabric 4 | Escalation only models forge/neoforge — correct for 86/90. |
| Packs whose newest release has no loader | **2** (`Vanilla` 81 — legitimately vanilla; `MindCrack Pack` 68 — zero versions) | Both are genuine, not bugs. |

## 3. The 5 new bugs this found (fixed, with regression tests)

1. **`path + name` rule was still heuristic.** Two earlier heuristics ("ends with name", "has a dot") were both
   wrong for some pack. Replaced with the census-proven invariant, and `..` is rejected inside the resolver as
   well as in `validateRecipe` (defence in depth).
2. **The recipe validator refused real Minecraft version names.** `18w43b`, `26.3-pre-1`, `26.4-snapshot-6`,
   `rd-132211`, `c0.0.11a` are legitimate; the strict `x.y[.z]` regex would have rejected those packs. New
   `isMinecraftVersionString()` accepts numeric releases, weekly snapshots, pre/rc/snapshot suffixes, and
   pre-alpha names while still rejecting `latest`/`unknown`.
3. **Duplicate destinations were installed twice.** Two different URLs writing the same path is at best wasted
   work, at worst a silent overwrite. Now deduped with a `ftb.duplicate-destination` warning.
4. **A declared Java 11 was a hard failure.** One pack declares `11.0.19+7`; the app provisions 8/17/21/25.
   Now rounded up to the next supported major with a `ftb.java-major-unsupported` warning — the pack installs
   instead of being refused.
5. **`hasModFiles` misclassified jars with no `type`.** It only checked `type === 'mod'`, so a jar with no type
   was treated as a loader-less modded pack and the *wrong* error was raised (and one legitimate test case
   became unreachable). Now a `.jar` under `mods/` counts, and the Minecraft-version check runs before loader
   inference because "no MC version" is the more fundamental failure.

## 4. The corpus test that replaces sampling

`scripts/conformance-ftb-corpus.mjs` runs the **real adapter** over **every published pack** and asserts the
canonical-recipe contract for each:

- `validateRecipe` passes (valid MC version, safe relative paths, resolvable sources, no `client-overrides`),
- no duplicate destination survives,
- no path escapes the server directory,
- every file has a URL or provider reference,
- a resolved `vanilla` result never ships `mods/*.jar`.

Result on the full catalogue: **92 packs scanned, 87 pass, 0 hard failures, 5 skipped (empty/versionless
packs), 83,177 files planned and contract-checked.**

This is the difference between "the five packs I tried work" and "the whole published corpus satisfies the
contract".

## 5. Discipline change (what I will do differently)

1. **Measure the corpus before writing the parser.** Field-level value-space census first (types, ordering,
   nulls, empties, distributions), then code. This single step would have prevented bugs 1–5.
2. **Distinguish "verified" from "sampled".** A run over N hand-picked packs is a sample, not coverage; it must
   be labelled as such or replaced by a corpus sweep.
3. **Fault-inject error paths.** Bug 6 (classifier missing a signature) and bug 7 (stale launch shape) were
   invisible to happy-path runs. `verify-escalation-fault.mjs` now injects a real loader fault and asserts the
   recovery path.
4. **Treat every assumption in code as a claim needing evidence** — the comments now cite the census rather
   than a guess.

## 6. Remaining honest limits

- The census and conformance sweep cover **FTB only** (92 packs). The other formats (packwiz, Prism,
  ATLauncher, GDLauncher, Technic, MCBBS, HMCL, plain server zips) have **no corpus yet** — when their adapters
  land, the same census-then-code order applies.
- Mojang/Forge/NeoForge/Fabric metadata endpoints are consumed from documented shapes; they were probed
  live but not censused at the same depth.
- Escalation still has no live forced-failure proof beyond the injected-fault harness (which now does exercise
  the branch: attack → classify → reinstall → re-resolve → boot OK).

## 7. Reproduce

```powershell
npm run build:electron
node scripts/census-ftb-api.mjs --max-packs 92 --max-versions 2   # measure the whole corpus (~4 min)
node scripts/conformance-ftb-corpus.mjs                            # assert the contract on every pack (~80 s)
node scripts/verify-escalation-fault.mjs 1.12.2                    # fault-inject the recovery path
node scripts/verify-ftb-install.mjs 6                              # full install + verified boot
```
