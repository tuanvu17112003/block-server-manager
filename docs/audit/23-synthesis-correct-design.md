# Synthesis: the one error behind every deviation, and the correct design

- Date: 2026-10-29
- Inputs: [19](19-stop-and-analyse-evidence-standard.md) (evidence grades) · [20](20-phase-a-real-artefact-findings.md)
  (6 deviations vs real artefacts) · [21](21-reader-design-reanalysis.md) (acquisition-shape axis) ·
  [22](22-research-conformance-diff.md) (11 deviations vs my own research)
- Status: **synthesis + design. No code changed.**

---

## 1. The three audits, and what each class of check found

| Audit | Compared code against | Found |
|---|---|---|
| 18 | FTB reality (92 packs) | 5 data-shape bugs |
| 20 | real artefacts (4 CF zips, 8 packwiz, 2 mrpack) | 6 deviations, 3 architectural |
| 22 | my own research doc | 11 deviations, incl. the biggest one |

The classes did not overlap. Each check catches something the others cannot:

- **Reality ≠ spec** → spec bugs (research was wrong: packwiz is HTTP, `modpack.toml` exists).
- **Reality ≠ code** → implementation bugs (missing modrinth adapter, unclaimed wrapper zip).
- **Spec ≠ code** → conformance bugs (I contradicted my own design).

All three were needed. The cheapest one (spec vs code) was run last.

## 2. The single error, stated once

Every deviation in all three audits reduces to one habit:

> **I optimised for producing working code instead of for maintaining a verified mapping between three things
> that must agree: the specification, the implementation, and reality.**

Concretely, each pair of the triangle failed at a different time:

```
        SPEC (research doc)
         ╲            ╱
    RD-1..7 ╲      ╱ RC-1..4
             ╲   ╱
    CODE ─────╳───── REALITY
         D1..D6
```

- **SPEC vs CODE (RD):** the spec said "modrinth first, so no regression"; I built new formats first. The spec
  said "normalize before detect"; I skipped normalization. These were *free* to check — the spec was in the
  repo — and I did not read it while implementing.
- **CODE vs REALITY (D):** fixtures I authored can only prove the code matches my beliefs, not reality.
- **SPEC vs REALITY (RC):** four spec claims were wrong, and only real artefacts revealed it.

The habit has a signature: **each hand-picked pack I ran taught exactly one bug, so each fix was local and
each new pack revealed the next.** Nine iterations of that produced nine local fixes and no verified mapping.

## 3. Why "fix the deviations" is the wrong next move

There are now 11 RD + 6 D deviations. Fixing them in the order I found them repeats the loop that generated
them. The ordering itself is the bug: I have been treating a **mapping** problem as a **bug-list** problem.

Evidence for that claim, from my own record: the last three phases each ended with a document claiming
convergence (docs 18, 19, 21), and each was followed by a new audit finding more deviations than the last.
That is not convergence — that is an unverified mapping being probed from a new angle each time.

## 4. The correct design, derived from the three audits

### 4.1 The axis that varies: acquisition shape (not format)

Confirmed by RC-1, RC-3, D1, D2. Five shapes exist; the current interface models three and excludes the two
that failed:

| Shape | Formats (measured) | Adapter receives |
|---|---|---|
| **A** manifest + CDN | Modrinth `.mrpack`, CurseForge client pack | archive or provider ids |
| **B** provider API | FTB (`api.modpacks.ch`, verified) | provider ids |
| **C** HTTP tree | packwiz (86/126 metafiles, each its own URL) | **base URL** |
| **D** archive, no manifest | CF author server pack, wrapper zip, bare dump | archive + structural normalization |
| **E** local instance | Prism `mmc-pack.json`, ATLauncher `instance.json` | directory; payload already local |

### 4.2 Three invariants that make the deviations structurally impossible

| Invariant | Kills |
|---|---|
| **I1. The registry covers the current working paths first.** Any format the product already installs must have an adapter that produces the *same* recipe as the existing engine, verified against real artefacts, before a single new format is added. | RD-1, D1 |
| **I2. Adapters recognise and normalise; they delegate execution to proven engines.** No adapter re-implements loading. | DE-3, D4 |
| **I3. A format is "supported" only after a real artefact of that format installs and boots end-to-end.** Fixtures and schema-derived archives cap at "unverified". | DE-4, RC-4 |

### 4.3 The normalisation stage the research specified and I skipped

Research §6 step 2, now non-optional and placed **before detection**:

```
list entries once → unwrap single nested zip (bounded) → strip single wrapping dir → ArchiveIndex
```

Measured need: the 1 GB real wrapper archive is nominally 2 entries and currently unclaimed by any adapter,
while the existing `curseforge.ts` already has `findNestedServerPackZip`. The normaliser must move into the
shared layer so every adapter benefits, rather than being re-implemented per engine.

### 4.4 Conformance must be executable, not prose

The research doc sat unread while I coded. That is a process failure with an engineering fix: the spec's
checkable claims become **tests** and a **checklist script**, so "did I follow the design?" is answered by CI
rather than by my memory. Initial set, from RD-1..RD-7:

- every format in the research §2 table either has a registered adapter, or is explicitly listed as
  deferred-with-reason (checked by asserting the two lists match);
- normalization step exists and is exercised by the wrapper-zip fixture;
- §7 gap table has a status column that a script verifies against actual code greps.

## 5. Ordered plan (each step gated on the invariant above)

| Step | Work | Gate (evidence, not opinion) |
|---|---|---|
| **C0** | Executable spec-conformance script: research §2 formats ↔ registered adapters, §7 gaps ↔ code | script fails on today's tree, listing RD-1..RD-7 |
| **C1** | `AdapterInput.shape` (A–E); registry refuses a shape an adapter does not declare | unit: archive cannot reach an httpTree adapter |
| **C2** | Shared normalisation (unwrap nested zip, strip wrapper) before detection | the real 1 GB wrapper archive resolves |
| **C3** | `modrinth` adapter as a **wrapper** over existing `resolveMrpack`; `curseforge` likewise over `inspectStagedZip` | both real `.mrpack` resolve; recipe **field-identical** to the existing path |
| **C4** | `plain.serverzip` delegates to the CF inspector + inference | all 4 cached CF server packs resolve |
| **C5** | packwiz as shape C (HTTP tree), with `pack.toml`/`modpack.toml` and subdirectory discovery | ≥5 real packs; GT:Modern (86) and Project-CBT (126) metafiles fully enumerated |
| **C6** | Prism/ATL labelled E3 and **not offered** as install sources | documented + UI/report honest |
| **C7** | §7 gaps 3,4,5,7,9 (Forge side rule, dependency rescue, anchored matching, learned-at-install, diffable manifest) | each against the cited real evidence; 12-pack matrix stays 12/12 |
| **C8** | Wire pipeline for E2 formats only | 12-pack matrix 12/12 + real FTB/packwiz/CF installs still boot |

C7 is deliberately after C0–C6: those gaps are pre-existing and verified separately, whereas the adapter layer
is new and currently net-negative if switched on.

## 6. What would make this converge (why it did not before)

Previously each phase ended when *tests passed*. Tests measure code-vs-belief. Convergence needs all three
edges of the triangle green:

1. **reality → spec:** a real-artefact sweep per format (Phase A harness, kept and extended);
2. **spec → code:** the executable conformance script from C0;
3. **code → reality:** real end-to-end install + verified boot per format (the existing matrix plus FTB/packwiz
   runs).

A phase is done when all three edges are green for the formats it touched — not when the unit suite is green.

## 7. Immediate honest status (nothing to celebrate)

| Component | Grade | Evidence |
|---|---|---|
| FTB remote API | **E1** | 92 packs, 83,177 files |
| FTB install | **E2** | 3 packs, verified boot, atomic publish |
| Modrinth / CurseForge install (existing engines) | **E2** | 12-pack matrix |
| Loader-build escalation | **E2** (fault-injected) | escalation branch recovered a bootable server |
| Adapter layer (as written) | **E3, and net-negative if enabled** | no modrinth/CF adapter; wrapper zip unclaimed; packwiz model wrong |
| packwiz / Prism / ATLauncher / serverzip adapters | **E3** | schema-derived; 3/8 real packwiz resolve |

The adapter layer stays **uncommitted and disabled** until C1–C4 give it the two formats that already work.
Its value is real — the FTB path proves the recipe abstraction works — but switching it on today would regress
`.mrpack` and the wrapper-archive case, which is precisely what invariant I1 exists to prevent.
