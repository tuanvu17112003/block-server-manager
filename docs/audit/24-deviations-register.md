# Deviations register (QA instrument)

This file is the **single place** where any deviation from the design is recorded: by the Lead, by any
teammate, and about the plan itself. It exists because the previous three phases each "converged" in prose
while accumulating verified-mapping debt (docs 18, 20, 22 found 5 → 6 → 11 deviations).

**Rule: if reality does not match the design, write a row here and stop. Do not improvise a fix.** An
unrecorded improvisation is a QA failure; a recorded deviation is data.

Design authority, in precedence order:
1. `docs/research/2026-10-29-universal-modpack-install.md` (the pre-implementation spec)
2. `docs/audit/23-synthesis-correct-design.md` (invariants I1–I3, acquisition shapes A–E, plan C0–C8)
3. `docs/audit/22-research-conformance-diff.md` (RD-1..7, RC-1..4)
4. `docs/audit/20-phase-a-real-artefact-findings.md` (D1..D6)

---

## How to record a deviation

Append a row to §2 with: id, phase, what the design says (quote + file:line), what reality showed, the
**command or evidence file** that showed it, and whether it blocks. If it blocks, say what decision is needed
instead of making one silently.

Evidence grades (from doc 19) — a claim may never exceed its grade:

| Grade | Meaning |
|---|---|
| **E1** | whole real population measured |
| **E2** | a real artefact of that format installed/booted end-to-end |
| **E3** | schema-derived fixture authored by us — **not proof of correctness** |
| **E4** | design only, no artefact ever parsed |

---

## 1. Session baseline (recorded before any change)

| Item | Value |
|---|---|
| HEAD at session start | `148ec23` |
| Unit tests | **328/328 pass** |
| `npm run verify` | not yet run this session (run before first merge) |
| Uncommitted work at start | P1c adapters (`packwiz`, `prism`, `atlauncher`, `serverzip`, `toml`) + tests + `verify-packwiz-archive.mjs` — **E3, deliberately uncommitted** |
| Adapter layer status at start | **disabled by design**; registering it today would regress `.mrpack` and wrapper archives (RD-1, RD-3) |

### Known deviations carried IN (from docs 20/22 — these are the work items, not new findings)

| Id | Deviation | Blocking phase |
|---|---|---|
| RD-1 / D1 | adapter layer has no `modrinth`/`curseforge` adapter; research §8:347 required them first "so no regression" | C3 |
| RD-3 / D4 | pipeline step 2 "Normalize" (unwrap nested zip, strip wrapper) never implemented; real 1 GB wrapper archive unclaimed | C2, C4 |
| RD-2 / DE-2 | `detect()` models only archive∪provider; no HTTP-tree or local-instance shape | C1 |
| RD-4 | Forge `mods.toml` side rule contradicts SPC (`core.ts:1124` all-`side=` vs platform-dependency `side`) | C7 |
| RD-5 | no dependency rescue (`provides` alias matching) — 0 hits in `installer/` | C7 |
| RD-6 | hand/learned exclusion matching is bare substring (`curated.ts:45,48`), no rule id | C7 |
| RD-6b | learned file not read at install; sidecar not diffable (no hashes/sizes) | C7 |
| RC-2 | packwiz also uses `modpack.toml` and packs may live in a subdirectory | C5 |
| RC-4 | fixtures cannot prove detection; real-artefact sweep is mandatory | C0 |

---

## 2. Deviations found during this session

<!-- Append rows here. Format:
| DV-nn | phase | Design says (file:line) | Reality | Evidence (cmd/artifact) | Blocks? | Decision needed |
-->

| Id | Phase | Design says | Reality observed | Evidence | Blocks? | Decision needed |
|---|---|---|---|---|---|---|
| DV-01 | C2 | Research §6 step 2: *"Normalize — list entries once; unwrap single nested zip; strip a single wrapping directory"* (research line 305) | Implemented as `electron/services/adapters/normalize.ts`; the shared layer had nothing and the CF engine had its own private unwrap | `node scripts/unit.mjs` → 336/336 (8 new normalize tests). Real artefacts: `normalizeArchive('.app-data/cache/cfpack/466901-server-9296268.zip')` → `unwrapped=true nested=Prominence™_II_Hasturian_Era_4.1.5_server_pack.zip`, 2 outer entries → **3,553 effective entries** incl. root `manifest.json`. Other two CF zips are no-ops (`unwrapped=false`, 4,951 and 9,503 entries) as intended | No | none — closed |
| DV-02 | C2 | Prefix stripping should produce the view an adapter needs | `stripPrefixFromIndex` exists but is **not yet wired into adapter detection** — adapters still see raw names. Deliberate: wiring belongs with the adapter-shape work (C1/C3) so the ownership of temp files is decided once | `grep -n 'stripPrefixFromIndex' electron/services/adapters/*.ts` → only `normalize.ts` defines/tests it | No (C3 depends) | decide in C3 whether the registry normalizes before `candidates()` or each adapter opts in |
| DV-03 | QA | A recorded deviation must never be silently fixed | My own test zip writer declared **deflate (method 8)** while writing stored bytes, producing `invalid stored block lengths` and 3 failing tests that looked like product bugs. This is the same class as doc 20 D5 (a lying harness hides or invents defects) | First run of `adapters-normalize.test.ts` failed 3/8 with that error; fixed by declaring method 0; now 8/8 | No | none — recorded so the harness is trusted |
| DV-04 | C2→C3 | Research §2 row 12: an SPC output archive is identified by `manifest.json` with `files[]` + `minecraftVersion` + `modloader` + `serverPackCreatorVersion`. C2 makes that manifest **visible** by unwrapping | After unwrapping, the 1 GB archive resolves to **3,553 entries including a root `manifest.json`**, yet `plain.serverzip` still fails with "no pack manifest and does not state its Minecraft version". The manifest is present with **exactly the fields research §2 row 12 predicts**: `{files, minecraftVersion, modloader, modloaderVersion, serverPackCreatorVersion}`, values `minecraftVersion="1.20.1"`, `modloader="Fabric"`, `modloaderVersion="0.19.3"`, 3,642 file entries. **No adapter reads it** — the SPC-output format has no adapter | `node scripts/audit-adapters-real.mjs --skip-packwiz` → `466901…: unwrapped … (2 → 3553 entries)` then `FAILED — This archive has no pack manifest…`; manifest content read directly from the unwrapped inner zip | **yes — blocks C4** | Needs a `serverpackcreator` adapter reading `manifest.json`. Do **not** widen `plain.serverzip` to guess; that would repeat the D4 mistake of a degraded duplicate. C4 scope, recorded now so it is not improvised. |
| DV-05 | C2 | `plain.serverzip` should resolve a real author server pack with derivable metadata | `829758-server-7243901.zip` (4,951 entries, real payload: `start.sh`, `variables.txt`, `server-icon.png`) fails: no `version.json`, no `libraries/` maven path, no installer jar. It is an SPC-style pack too, so its `manifest.json` is the correct source — same root cause as DV-04 | same harness run | **yes — blocks C4** | same decision as DV-04; resolve via the SPC manifest adapter, not by loosening `plain.serverzip` |
| DV-06 | C1/C3 | Every write scope is exclusive; the plan assigns C1/C3 to one owner | **The Lead parallelised its own C1/C3 edits with a delegated task on the identical files and created no isolation.** The delegate detected it from file mtimes (`types.ts` 20:19:29, `registry.ts` 20:19:50, `modrinth.ts` 20:20:05) plus the `7634736` commit landing mid-session, and **stopped instead of clobbering** — the correct behaviour. Cost: ~10 min, a transient non-compiling tree (`~30 TS errors`: old `DetectContext` in prism/serverzip/ftb, tests on old `{archive}` literals, `pipeline.ts:522` mismatch), and one wasted delegation. | Delegate's message quoting mtimes and the commit; `git log -1` → `7634736`; `npm run build:electron` failing during the window | No (recovered) | **Process decision, binding for the rest of the session: the Lead either reserves a write scope exclusively or delegates it — never both.** When a collision is detected, the delegate must stop and record (as happened), not race. |
| DV-07 | C0/C7 | The conformance script should report *code* state, not text occurrences | `conformance-spec.mjs` check 3c counts bare `includes(` by grep, so after the gap5 fix it still reports **1 occurrence at `curated.ts:45`** — which is a *comment* explaining the old behaviour, not code. The instrument is over-counting, and the honest response is to record that rather than delete the explanatory comment to make the checker green | `node scripts/conformance-spec.mjs` → `[gap5] curated.ts:45 … 1 bare includes(`; `Select-String curated.ts -Pattern 'includes\('` → the only hit is line 46, inside a `//` comment | No (gap5 is actually fixed; the C0 report is conservative) | Improve the checker to strip comments before grepping (C0 follow-up), or accept a conservative false-positive. **Do not** edit production comments to satisfy a grep — that would be gaming the instrument |
| DV-08 | C7 | gap3 must be replaced by ServerPackCreator's platform-dependency rule, verified by behaviour not by grep | Implemented `parseForgeDependencies` + `forgeTomlIsClientOnly` in `core.ts` and 7 tests from the real predicate differences. Two genuine bugs surfaced while writing the parser and were fixed: (a) a new `[[dependencies.<mod>]]` header must flush the previous entry — without it two consecutive blocks collapsed to zero entries; (b) entries were pushed into a discarded local array instead of the map bucket, so every parse returned `[]`. The C0 checker only verifies the old predicate is *gone*, so it would have gone green on a parser that returned empty — this is exactly the "checker verifies absence, not correctness" limit the C0 author flagged | parser probe printed `entries: []` before the fix and `[{modId:"forge",side:"BOTH"},{modId:"minecraft",side:"CLIENT"}]` after; unit 336 → **345**; conformance gap3 → CLOSED | No | none — recorded because the behavioural tests, not the grep, are what actually prove gap3 |

---

## 3. QA sign-off log

Each phase closes only when **all three edges** of the triangle are green (doc 23 §6): reality→spec
(real-artefact sweep), spec→code (conformance script), code→reality (real install + verified boot). Unit tests
alone are explicitly **not** sufficient.

| Phase | reality→spec | spec→code | code→reality | Signed off by | Notes |
|---|---|---|---|---|---|
| C0 | **green** — the script reads the real spec lines (§2 formats, §6 step 2, §7 gaps) and attributes every finding to file:line | **green** — `scripts/conformance-spec.mjs` + `scripts/conformance-waivers.json`; 9 checks, 4 closed, **5 open**; verdict FAIL by design | n/a (measurement) | **QA accepted** | Delivered by delegated subagent; 13 research formats parsed, 6 adapters registered, 7 covered + 6 explicitly waived. Open items with exact locations: gap3 `core.ts:1124`, gap4 zero provides/rescue matches in `installer/`, gap5 `curated.ts:44,45,47`, gap7 `pipeline.ts:234` (6/6 resolver calls omit learnedFile), gap9 `pipeline.ts:796` (3 sidecar payloads record paths only). This is the exact C7 worklist. |
| C1 | n/a (contract only) | **green** — shapes A–E implemented; registry refuses undeclared shapes (`shapes.includes(input.shape)` guard) | n/a | Lead | unit 328 → **336**, verify 10/10. DV-06 records the write-scope collision that cost ~10 min |
| C2 | **green** — real 1 GB wrapper unwraps 2 → 3,553 entries exposing the SPC manifest | **green** — research §6 step 2 implemented in shared layer | n/a (install is C8) | Lead | 8 normalize tests; DV-01; found DV-04/DV-05 |
| C3 | **green** — both real `.mrpack` files resolve; Prominence = Fabric 0.19.3 / MC 1.20.1 / 565 files (352 required, 213 unsupported) matching the known reference | **green** — delegates to `resolveMrpack`/`splitDeps`, no reimplementation | **partial (E2−)** — resolve parity proven; end-to-end install is C8 | Lead | `docs/evidence/adapters/modrinth-recipe-parity.json`. CurseForge half **not done** (see DV-04/05) |
| C4 | — | — | — | — | **open** — blocked on DV-04/DV-05: no adapter reads the SPC `manifest.json` that C2 exposes |
| C5 | — | — | — | — | **open** — packwiz is still archive-only; 3/8 real packs resolve |
| C6 | — | — | — | — | **open** — Prism/ATLauncher still need explicit E3 labelling |
| C7 | **green for gaps 3 and 5** — proven behaviourally, not by grep (DV-08) | **green** — SPC platform-dependency rule + anchored matching with rule ids | n/a (unit + gate) | Lead | unit 336 → **345**, verify 10/10, conformance gap3 CLOSED. **gap4, gap7, gap9 still open** |
| C8 | — | — | — | — | **open** — required before anything may be called "supported" (invariant I3) |

### Current gate state at `5671114`

| Gate | Result |
|---|---|
| `npm run build:electron` | clean |
| `node scripts/unit.mjs` | **345 / 345 pass** |
| `node scripts/verify.mjs` | **10/10 PASS** |
| `node scripts/conformance-spec.mjs` | FAIL by design — 9 checks, 5 closed, 4 open (gap4, gap5-false-positive, gap7, gap9) |
| `node scripts/audit-adapters-real.mjs --skip-packwiz` | real archives **4/6**; formats observed: `plain.serverzip`, `modrinth.mrpack` |

### What is NOT done (do not read the green rows as completion)

- **CurseForge adapter** (C3 second half) — needs the SPC-manifest adapter; 2 of 4 real CF archives still fail.
- **C4, C5, C6, C8** — untouched.
- **gap4 (dependency rescue), gap7 (learned at install), gap9 (diffable sidecar)** — untouched, listed by C0 with file:line.
- **No real end-to-end install has been run through the adapter layer.** Every claim above is resolve-level
  (E2− at best). Invariant I3 says a format may be called *supported* only after a real install boots.


