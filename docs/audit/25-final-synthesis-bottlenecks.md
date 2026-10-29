# Final synthesis — C0–C8 remediation, what was actually wrong, and what is still not proven

Date: 2026-10-29 · Branch `master` · Session goal: make Modrinth and CurseForge server installs
correct, with every deviation recorded rather than improvised around, and every claim backed by a real
artefact.

This is the consolidated findings report the plan asked for. It is written to be read *against* the
deviations register (`docs/audit/24-deviations-register.md`, DV-01 … DV-29), not instead of it.

---

## 1. The single underlying error, stated once

The project was not short of engineering effort — it was short of a mechanism connecting three things that can
each drift independently: **what reality does**, **what the spec says**, and **what the code does**.

Concretely, the pre-implementation research document (`docs/research/2026-10-29-universal-modpack-install.md`)
was written as a design, then treated as a description of reality. Its format table (§2) listed 13 formats as if a
registered adapter implied the format worked; its own step 2 ("Normalize — unwrap single nested zip") was
specified and never implemented; and its "T0 fixtures" were hand-authored and then counted as proof that detection
worked. Each individual fix afterwards was reasonable. The loop was not: **find a bug → patch it → declare victory
→ find another bug**, with no artefact recording which claims had been checked against a real pack.

Doc 19 (evidence grades E1–E4) and doc 23 (five acquisition shapes, invariants I1–I3, plan C0–C8) are the answer,
and this session implemented them.

## 2. What was actually broken — the true bottlenecks, ranked by damage

Ranked by how much wrong behaviour each caused, not by how hard it was to fix.

| # | Bottleneck | Why it caused the most damage | Now |
|---|---|---|---|
| 1 | **No adapter existed for the formats the app actually installs** (RD-1/D1) | The research said to cover modrinth + curseforge *first* "via the new path, so no regression". That order was inverted, so the adapter layer was built for peripheral formats while the two that matter had no adapter at all. Every other adapter bug was cosmetic next to this. | Modrinth + 2 CurseForge + SPC adapters added, all **delegating** to proven engines (I2) |
| 2 | **Normalization was specified and never implemented** (RD-3) | A real 1 GB author archive wrapped a nested zip, so *no adapter could claim it* — the file was structurally invisible. Not a parsing edge case: the pack simply could not be seen. | `normalizeArchive`: measured **2 → 3,553 entries** on the real archive |
| 3 | **The install-time learner was wired on one side only** (gap 7, DV-27) | The boot-time learner read and wrote `env-overrides-learned.json`, so learning improved server *starts*; the install-time planner never consulted it, so a mod already known to need disabling was still downloaded every time. The feature looked present because half of it was. | `learnedFile` passed at all 5 live call sites |
| 4 | **Exclusion matching used bare substring** (gap 5, RD-6, DV-11) | `figura` matched `configurable` (itzg #4234) — silently dropping a server-required mod with no log line. Worse, my own first fix *inverted* the `unlessPresent` guards: normalizing the guard paths stripped every separator, so all 10 real guarded entries silently read "dependency absent". | word/version-suffix anchored matcher, guards on raw paths, rule id in every verdict |
| 5 | **The Forge client-only rule disagreed with the reference implementation** (gap 3, RD-4) | `sides.every(s => s === 'CLIENT')` over *any* `side=` occurrence. ServerPackCreator's rule is narrower: only the **platform** dependency's `side` states the mod's own sideness. The difference drops working mods or keeps broken ones, silently. | SPC rule implemented + 7 behavioural tests |
| 6 | **Excluding a mod could strand its dependents** (gap 4, RD-5) | Zero `provides`/rescue code existed. Excluding `fabric-api` while keeping 40 mods that need it produces a boot failure with no explanation. | `rescueDependencies` with provides-alias fixpoint, iterated like `ModListCompiler` |
| 7 | **The sidecar recorded paths only** (gap 9, DV-28) | The data (`sha1`/`sha512`/`size`) was already on every `PlannedFile`; it was never written, so a reinstall re-downloaded everything blind. | per-file hash/size; the CF branch records archive identity instead of inventing hashes |
| 8 | **An adapter declared a shape it could not handle** (DV-22) | packwiz advertised `httpTree` while implementing only archives: `detect` returned false, `resolve` threw. The registry routes on the declaration, so nothing caught it. | shape C implemented; 12 tests |
| 9 | **Evidence grade lived in prose, not in the type** | The original error was claiming coverage from fixtures. A comment saying "E3" cannot prevent that. | `PackRecipe` **requires** `evidenceGrade` + `evidenceNote`; `validateRecipe` enforces it |

## 3. What is now proven, and at what grade

Grades are from doc 19. **Only E2+ may be called "supported".** This table is the honest answer to "does it work".

| Format | Grade | What that rests on |
|---|---|---|
| **Modrinth `.mrpack`** | **E2** | A real pack installed **through the adapter layer** and reached a verified boot: 341 mod jars published, stages `download/validate/verify-boot(complete)/publish(complete)`, 319 s. Preview produced **351 include / 211 exclude** — identical to the existing engine's recorded split, which is invariant I1 demonstrated, not asserted. |
| **packwiz (archive)** | **E2** | A real zipped pack installed end-to-end: loader installed, payload extracted, **128,551-byte** jar downloaded from the real CDN, metadata excluded. |
| **packwiz (HTTP tree)** | E3→resolve | Both declared shapes work; side mapping proven (`side="client"` → `unsupported`). No real HTTP tree existed on disk to install from, so it is resolve-level only. |
| **FTB** | **E2** | Installs exercised end-to-end against the live API earlier this session; loader-build escalation fault-injected and recovered. |
| **CurseForge (client + server pack)** | **E2 on its own engine; E3 for the shape-A adapters** | The 12-pack acceptance matrix installed **6 CurseForge packs end-to-end with verified boots** (Dungeon Heroes, RLCraft, SkyFactory 5, DawnCraft, Otherworld D&D, Prominence II CF) through the key-mode provider path, which is **shape B** and needs no adapter (DV-43). The two `curseforge.*` adapters serve **shape A** — a zip the user supplies — and are E3 because that path has resolve parity only. |
| **ServerPackCreator output** | **E3** | The real 1 GB wrapper resolves from its declared `manifest.json` (fabric 0.19.3 / 1.20.1, corroborated by three independent sources). Not installed. |
| **Prism / ATLauncher** | **E2** | Both now rest on real third-party artefacts, not schemas: a CI-built PrismLauncher instance export (`mmc-pack.json`, sha256 `15456AB9…`) resolving **forge 47.4.0 / MC 1.20.1**, and a user-published ATLauncher `instance.json` from issue #875 (sha256 `0E2DD9DC…`) resolving **"eTards Create++" / Forge 47.2.17 / 1.20.1 / 290 mods**. Both preserved under `docs/evidence/adapters/` and checked by checksum in gate steps. Not E1: one instance each is not the population, and neither carries a server payload, so no boot was performed. **DV-44 added a UI rule so this is not overpromised: a plan with zero files renders as amber "Launcher instance — no files to install", never as a green verified badge.** |
| **Bare server zip** | **E3** | Two real archives resolve, but it plans no downloads and was not installed via the adapter path. |

Real-artefact coverage: **6/6** cached archives resolve (was 0/6 when the session's adapter work began).

## 4. Gates — measured, on a quiet tree

| Gate | Result |
|---|---|
| `npm run build:electron` | clean |
| `node scripts/unit.mjs` | **416 / 416 pass** (336 at session start → 403 after C0–C8 → 416 after the hardening pass) |
| `node scripts/verify.mjs` | **14/14 PASS** — 10 → 12 when conformance + adapter-audit became gate steps, then → 14 with `prism-real` and `atl-real` (`docs/audit/26` Item 1, §9) |
| `node scripts/conformance-spec.mjs` | **PASS — 9/9 closed, 0 open** |
| `node scripts/audit-adapters-real.mjs --skip-packwiz` | archives **6/6** |
| `node scripts/verify-adapter-install.mjs` | **PASS** (E2 install) |
| `node scripts/verify-packwiz-archive.mjs` | **PASS** (E2 install) |
| `node scripts/live-matrix.mjs` | **PASS 9/9** (Java matrix, Adoptium 21/25, live loaders, NeoForge installer, CF staging) |
| `electron . --matrixtest` (12-pack acceptance) | **12/12 PASS**, every pack `verify-boot: complete`, 15:29:56 → 16:01:26 |

## 5. What is NOT done — read this before believing anything above

- **CurseForge key-mode installs (6/12 of the acceptance matrix) run on their own proven engine, not on the new
  adapters — and that is the final answer, not a gap.** This was originally written as "closing that means routing
  the CurseForge pipeline through the adapter layer". Investigation showed that would be wrong (DV-43): the provider
  API returns metadata only (`CfProjectMeta` has no file list), so a shape-B adapter could neither produce a
  `recipe.files[]` nor delegate — it would have to re-implement `installCurseforge`'s server-pack resolution,
  violating invariant I2 and risking six working packs for an architectural name. The two CurseForge `*` adapters
  serve shape A (a zip the user supplies) and say so in their `evidenceNote`; shape B needs no adapter.
- **C4/C5's SPC and HTTP-tree halves are resolve-level only.**
- ~~The 12-pack live matrix was not re-run~~ — **it was, and passed 12/12** (15:29:56 → 16:01:26, every pack
  `verify-boot: complete`). This is the strongest single result of the session: 6 Modrinth + 6 CurseForge packs,
  real network, real Java, real boots. Note it exercises the legacy engine paths, so it does not by itself
  upgrade the adapter layer's grade (see the CurseForge line above).
- ~~Prism/ATLauncher remain unproven by construction~~ — **both are now E2 on real third-party artefacts** (§9 of the hardening brief). Neither carries a server payload, so "resolved and recognised" is the claim, not "boots".
- **`plain.serverzip` plans no downloads** and returns a root override layer, so "resolves" there means
  "claims and classifies", not "installs". Recorded, not hidden.
- **Four formats carry explicit waivers** (MCBBS, HMCL server, GDLauncher, Technic) — deferred with reasons in
  `scripts/conformance-waivers.json`, never implemented. The checker reports C1 as closed *because* every
  uncovered format is waived; "closed" there means "accounted for", not "working". **Audited the cost of leaving
  them (DV-45): the create wizard exposes only four source kinds and none of these formats is reachable from the
  UI, so no user path leads to them; a user who supplies such an archive gets the recorded reason instead of a
  generic error.** GDLauncher is the one that is genuinely bigger than it looks — `gdlpack.json` is hash-only
  resolution and needs a provider layer first.

## 6. QA findings about the process itself — the part worth keeping

Twenty-nine deviations are recorded. Nine of them are about the *verification*, not the product, and those were
the most valuable:

- **DV-06 / DV-09 — write-scope collisions, mine.** I edited files I had also delegated. Both delegates detected
  it from file mtimes and **stopped instead of clobbering** — the right call. Rule adopted: a write scope is
  either reserved or delegated, never both.
- **DV-13 — a gate result obtained during concurrent writes is not evidence.** A `verify` run scored 9/10 (unit
  FAIL) while the identical tree passed 384/384 before and after. Root cause found, not guessed: `dist-electron`
  was rewritten at 20:55:38, *after* that run's build step finished at 20:51:13. The rule now is: confirm the tree
  is quiet before treating a gate result as evidence, and discard rather than explain away a contaminated one.
- **DV-23 — the harness was wrong twice before the product passed.** A central-directory offset of `0` made a TOML
  read return a different entry's bytes (looked exactly like a parser bug), then a dead fixture URL returned
  HTTP 400. Both times the instrument was at fault.
- **DV-26 — my own codemod corrupted eight files** by assuming single-line `resolution` blocks; `tsc` caught it,
  `git checkout` recovered it, and it was redone as an idempotent script that prints what it inserted.
- **DV-29 — fix the ruler, not the thing being measured.** With gap5 genuinely fixed, the checker still failed
  because a *comment* describing the old defect matched its grep. Deleting the comment would have made the tool
  green and lost the explanation. The checker now strips comments.
- **DV-07 / DV-19 — the checker earned its keep in both directions.** It caught my stale waiver (forcing C1 open
  again after I registered the SPC adapter), and it flagged a defect class I would otherwise have papered over.
- **DV-20 / DV-21 — a correct outcome via a wrong mechanism is not a pass.** The 9 mods the boot disabled were
  exactly the guarded hand entries whose dependencies were present; had the DV-11 anchoring bug survived, those 9
  would have been excluded at preview for the wrong reason and the L3 evidence would never have appeared.

## 7. The one-line version

The code was never the hard part. **Making it impossible to claim something works without a real artefact saying so** was the hard part — and that is now enforced three ways: a conformance script that reads the spec and fails on disagreement (9/9 closed), a required evidence grade on every recipe (the compiler refuses a recipe without one), and an audit harness that only counts real cached packs. Everything the plan asked for now has a number behind it: unit 403/403, verify 10/10, conformance PASS, real archives 6/6, and the 12-pack acceptance matrix 12/12 with verified boots. The remaining honest gap is narrower than when the session began and is stated plainly: the new CurseForge **adapters** have not been exercised end-to-end, even though CurseForge **installs** have.







