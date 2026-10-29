# Brief — post-C0–C8 hardening pass

Date: 2026-10-29 (Asia/Saigon) · Branch `master` · Base commit `c40b3b0`
Purpose: this file is the **contract** for the next pass. If anything unexpected happens, check it against
here first — a deviation from this brief is recorded in `docs/audit/24-deviations-register.md`, not improvised
around. Same rule as the previous session: *a recorded deviation is data; an unrecorded one is a QA failure.*

---

## 0. Where things stand (verified, not recalled)

Measured at `c40b3b0` on a quiet tree:

| Gate | Result |
|---|---|
| `node scripts/unit.mjs` | 403 / 403 |
| `node scripts/verify.mjs` | 10 / 10 PASS |
| `node scripts/conformance-spec.mjs` | PASS — 9 checks, 9 closed |
| `node scripts/audit-adapters-real.mjs --skip-packwiz` | real archives 6 / 6 |
| `electron . --matrixtest` | 12 / 12 PASS, every pack `verify-boot: complete` |

Grades (`docs/audit/19` §2 — only E1/E2 may be called "supported"):
Modrinth **E2** (installed+verified through the adapter layer) · packwiz archive **E2** · FTB **E2** ·
CurseForge engine **E2** (6/12 matrix packs) · `curseforge.*` adapters **E3** · SPC **E3** ·
Prism/ATLauncher **E3** · bare zip **E3**.

## 1. Why this pass exists

The previous session proved the *product* works. It did **not** make that proof self-sustaining. Three things
verified above are scripts a human must remember to run, and one is a grade no user can see. If nobody runs
them, the drift returns exactly as before.

So this pass is about making the verification **automatic** and the evidence grade **visible**, not about
adding features.

## 2. Items, in order of damage-if-ignored

### Item 1 — Put conformance and the real-artefact audit inside `verify.mjs` (highest value)

**Problem, confirmed:** `scripts/verify.mjs` runs 10 steps and neither `conformance-spec.mjs` nor
`audit-adapters-real.mjs` is among them (`Select-String verify.mjs -Pattern conformance` → no hits). A future
change can break spec-conformance and the gate still prints **10/10 PASS**.

**Change:** add two steps after `unit`:
- `conformance` → `node scripts/conformance-spec.mjs` (must exit 0)
- `adapter-audit` → `node scripts/audit-adapters-real.mjs --skip-packwiz` (must resolve all cached archives)

**Why not `--skip-packwiz` removed:** the packwiz real-artefact corpus is empty on this machine (0 files), so
running it without the flag buys nothing and would make the step depend on network. Revisit when a real
packwiz artefact exists.

**Acceptance:** `node scripts/verify.mjs` prints **12/12** and fails if either new step fails. Prove the guard
actually guards by temporarily breaking one check and observing a red gate, then reverting.

### Item 2 — CurseForge: correct my own earlier proposal, then decide with evidence

**Correction, stated before doing any work.** In the chat summary I proposed "route the CurseForge pipeline
through the adapter layer". On inspection that was imprecise, and this brief exists partly to catch that:

- `source.kind === 'curseforgeProject'` (key mode) resolves through `inspectCurseForgeProject` at
  `pipeline.ts:510-523` — the **(B) provider-API acquisition shape**. The 12/12 matrix exercises this path.
- `source.kind === 'packArchive'` (user drops a `.zip`) goes through `adapterRegistry.resolve` at
  `pipeline.ts:524+` — the **(A) archive shape**. This is what `curseforge.client` and
  `curseforge.serverpack` serve.
- Both CF adapters declare `shapes: ['archive']` only.

So the two CF paths are **not** duplicated logic for one shape — they are two different acquisition shapes,
which is exactly what doc 23 §4.1 says should exist. The real gap is narrower: **there is no
`curseforge.provider` adapter for shape B.** I will not "unify" them by pushing a working E2 path through new
code; invariant I1 says cover the working path first, meaning **do not risk the 12/12 matrix for tidiness**.

**Change:** none to the install path in this pass. Instead:
1. Record the corrected analysis (DV row) so the next reader does not repeat my error.
2. Make the boundary explicit in code comments at `pipeline.ts:510` and in the `curseforge.*` adapters, so
   nobody later assumes key-mode traffic flows through them.
3. Write down the shape-B provider adapter as a **scoped, not-started** item with its own risk note.

**Acceptance:** the 12/12 matrix path is untouched (`git diff` shows no change under `inspectCurseForgeProject`
or the `curseforgeProject` branch), and the analysis is recorded.

### Item 3 — Prism / ATLauncher cannot reach E2 in this pass (blocked, not skipped)

**Finding, confirmed by sweep:** a recursive scan of `.app-data` finds no `mmc-pack.json` and no ATLauncher
`instance.json` anywhere. There is no real instance to install.

**I will not author one and call it real.** A hand-written `mmc-pack.json` is a fixture I wrote, i.e. E3 by
definition — labelling it E2 would be the exact error this whole remediation exists to prevent (doc 22 RC-4).

**Change:** none to code. The item needs the **user** to export one real Prism instance and one real
ATLauncher instance into the test corpus. Until then both stay E3, and that is the correct grade.

**Acceptance:** recorded as blocked with the specific input required.

### Item 4 — Surface the evidence grade where the user chooses a pack

**Problem, confirmed:** `Select-String src -Pattern evidenceGrade` → no hits. The grade is on every recipe and
enforced by `validateRecipe`, but the UI never shows it. A user picking a Prism instance cannot know it is E3.

**Change:** show the grade (and its note) in the create/preview surface, driven by the existing preview DTO —
no new backend call. E1/E2 read as supported; E3/E4 must read as *not* supported, in words, not just a code.

**Why it matters:** the principle was "no unsupported claim". If only the code knows the grade, the principle
is half-done.

**Acceptance:** the preview UI renders the grade; a unit/UI assertion pins that E3 does not render as
"supported"; `verify.mjs` stays green (the `uitest` step exercises the create wizard).

### Item 5 — Waived formats must fail with a real reason, not a generic error

**Problem:** a user who drops an MCBBS/HMCL/GDLauncher/Technic pack gets `Unrecognized modpack format` and
has no idea the format is *known but deliberately deferred*.

**Change:** when detection fails, consult `scripts/conformance-waivers.json` shape (or mirror it in the app as
a small deferred-format table) and, if the archive matches a waived format's signature, say so:
"<format> is a known format this build does not support yet" + the recorded reason. Never pretend it might
work; never imply we will guess.

**Acceptance:** a crafted archive carrying only a waived format's marker produces the deferred message rather
than the generic one, and an archive matching nothing still produces the generic one.

## 3. Non-goals (explicitly not doing)

- No new format adapters. 6/6 real artefacts resolve and 12/12 packs install.
- No refactor of the adapter layer (403 tests, 9/9 conformance — it is not the problem).
- No larger matrix. 12/12 is the acceptance criterion; more packs do not add as much confidence as closing
  the gaps above.
- No change to the install/loader/escalation machinery that the matrix depends on.
- No touching real `.app-data` or legacy Tauri data.

## 4. Verification plan

After each item: `npm run build:electron` → `node scripts/unit.mjs` → `node scripts/conformance-spec.mjs`.
After all items: full `node scripts/verify.mjs` (expect **12/12** once Item 1 lands), on a **quiet tree** —
the rule from DV-13 still applies: *a gate result obtained while another writer is active is not evidence.*

The 12-pack matrix is **not** re-run in this pass: nothing here touches the install path (that is the point of
Item 2's no-change decision). If that ever becomes false, the matrix must be re-run and this brief amended.

## 5. Rollback

Each item is an independent commit. Items 1, 4, 5 touch only `scripts/verify.mjs`, `src/**`, and one error
path — `git revert <sha>` restores the previous behaviour with no data migration. Item 2 is documentation and
comments only.

## 6. Risk register for this pass

| Risk | Mitigation |
|---|---|
| Item 1 makes `verify` slower and the new steps are flaky | Both scripts are local-only and deterministic; measure the added time and record it. If a step is flaky, it is fixed or waived loudly — not silently dropped |
| Item 4 touches the create wizard, which `uitest` drives | Change is additive rendering of an existing field; `uitest` runs in the same gate and must stay green |
| Item 5's format-signature table drifts from `conformance-waivers.json` | Single source: derive the deferred list from one module, and pin it with a test that compares against the waivers file |
| Someone reads Item 2 as "CF finished" | Acceptance requires the boundary comment + DV row naming shape B as not started |

## 7. Definition of done for this pass

1. `node scripts/verify.mjs` → **12/12**, and demonstrably red when a conformance check is broken.
2. Evidence grade visible in the preview UI; E3 never rendered as supported.
3. A waived-format archive produces a deferred message with the recorded reason.
4. `curseforgeProject` key-mode path byte-identical to `c40b3b0` (verified by `git diff`).
5. New DV rows for: the corrected CF analysis, the Prism/ATL block, and anything that deviates from this brief.
6. `docs/audit/25-final-synthesis-bottlenecks.md` updated to match what is actually true after this pass.

---

## 8. Outcome — this section is the reconciliation against the sections above

Completed 2026-10-29 after the brief was committed at `51e368c`. Every item below is checked against its own
acceptance criterion from §2; where reality differed from the brief, it is stated rather than smoothed over.

| Item | Brief said | Actual outcome | Commit |
|---|---|---|---|
| 1 — gate the spec | add 2 steps, prove the guard guards | `verify.mjs` **12/12** (conformance 99 ms, adapter-audit 15 s). **Guard proved**: a stale `packwiz` waiver made conformance exit 1 and the gate **FAIL 11/12**; restored (`git diff` empty) → 12/12 | `5190c90` |
| 2 — CurseForge | correct my own proposal, do **not** touch the E2 path | Corrected and recorded. `git diff` on the install path: **zero removed lines**. Boundary comments added at `pipeline.ts:510` and in `curseforge.client`; `curseforge.provider` (shape B) written down as scoped-not-started | `20f5153` |
| 3 — Prism/ATL | blocked, needs a real instance from the user | **Blocked, not worked around.** Re-verified: no `mmc-pack.json` / `instance.json` anywhere; the only `pack.json` hits are shader packs. No synthetic instance authored, because that would be E3 labelled E2 — the original error | (DV-34) |
| 4 — show the grade | surface it in the preview UI | DTO carries `{grade, note, formatId}`; `PipelineReview` shows a green "Verified format" or amber "not yet proven" badge plus an alert. 5 tests incl. fail-closed on unknown/lowercase/future grades. Unit 403→408 | `8846e7f` |
| 5 — deferred formats | real reason, not a generic error | Done, **and it exposed two real defects** (see below). 10 tests incl. a drift guard against `conformance-waivers.json`. Unit 408→416 | `4d1ba59` |

### Where the brief was wrong or incomplete

Recorded because the brief exists to be checked against, not to be flattered:

1. **Item 2's premise was mine and it was wrong.** The brief's own §2 corrects the chat summary: CurseForge key
   mode is acquisition **shape B**, and the adapters are shape **A**, so there was no duplicated logic to unify.
   Had I implemented the original proposal, the 12/12 matrix would have been put at risk for symmetry (DV-33).
2. **Item 5 needed to run earlier than the brief implied.** I put the check where the generic error was thrown —
   which is *after* adapter selection — and it never fired, because `plain.serverzip` claims any manifest-less
   archive. The fix had to move **before** `candidates()`. That is the D4 silent-degradation shape reappearing in
   the very code meant to explain formats.
3. **A name mismatch the brief did not anticipate:** the app said "HMCL server pack", the waiver said
   "HMCL server". Caught by the drift guard I wrote rather than by review — which is the argument for writing it.

### Final gates after this pass

| Gate | Result |
|---|---|
| `node scripts/verify.mjs` | **12/12 PASS** (was 10/10 before Item 1) |
| `node scripts/unit.mjs` | **416 / 416** (was 403) |
| `node scripts/conformance-spec.mjs` | **PASS — 9/9 closed** |
| `node scripts/audit-adapters-real.mjs --skip-packwiz` | real archives **6/6** (now a gate step) |

**Not re-run in this pass, deliberately:** the 12-pack matrix. Nothing here touches the install path — that was
the point of Item 2's no-change decision, verified by `git diff` showing zero removed lines. If a future change
does touch it, the matrix must be re-run and this brief amended.

### Still open (unchanged by this pass)

- **CurseForge shape-B provider adapter** does not exist; `curseforge.*` adapters remain **E3**.
- **Prism / ATLauncher remain E3** until a user supplies one real instance of each.
- **Four formats deferred** with recorded reasons, now surfaced to the user instead of hidden.

### A defect Item 1 created and this pass then had to fix

Making `audit-adapters-real.mjs` a gate step immediately exposed a problem the brief did not foresee:
the harness wrote `startedAt` / `finishedAt` / `durationSeconds` into its **committed** evidence file. That was
harmless while it was a manual script, but as a gate step it meant **every `verify.mjs` run left the tree dirty**,
and the committed `docs/evidence/adapters/real-artefact-audit.json` could never describe the tree that produced
it — it would always be one run behind. Committing the refreshed file each time is not a fix; it is churn that
hides real evidence changes among timestamp noise.

Fixed by moving run-specific timing to the console and keeping only what was measured in the file
(commit `c724e4c`). Verified by running the harness twice and then the full gate twice: **no diff, 12/12, tree
clean**. Worth recording because it is the same lesson as DV-13 in a new place — a gate that mutates the tree it
is judging is not a trustworthy judge.
