# Re-analysis: what the adapter layer should actually be (and why the last design was wrong)

- Date: 2026-10-29
- Inputs: [19](19-stop-and-analyse-evidence-standard.md) (evidence grades, the unfalsifiable-claim pattern) and
  [20](20-phase-a-real-artefact-findings.md) (six deviations measured against real artefacts).
- Status: **design document. No code changed.**
- Purpose: derive the correct architecture from the evidence, instead of continuing to patch.

---

## 1. The four mistakes, stated as design errors (not bugs)

The six deviations in doc 20 are symptoms. Reduced, they are four design errors, each traceable to a
statement I made that was never tested:

| Design error | What I assumed | What the evidence says |
|---|---|---|
| **DE-1: partial mapping** | "Adapters are for the formats that don't work; the working ones need none." | An adapter layer is a **complete** mapping of the input space. Omitting `modrinth` means the generalisation cannot even re-express what already works — so routing through it *regresses* `.mrpack`. |
| **DE-2: format = archive** | "A pack format is a zip." | packwiz is **HTTP-transport**: `pack.toml` → `index.toml` → N metafiles, fetched individually (measured: 86 and 126 metafiles, each its own URL). A zip is an accident of how someone packaged it. Modrinth/CurseForge are **manifest+CDN**. FTB is **API**. Only the "author server pack" and bare dumps are genuinely archives. |
| **DE-3: parallel implementation** | "A new layer should own loading, so write it fresh." | The existing CurseForge engine already unwraps nested zips and infers metadata (the 12-pack matrix proves it). My adapter reimplemented that *worse*: it failed on the 1 GB wrapper and on the blank-metadata archive. New layer + old layer = two truth sources, one of them degraded. |
| **DE-4: fixture as evidence** | "If tests pass, the format handling is verified." | 328 passing tests coexisted with a missing format and a wrong input model. Fixtures I author encode my design; they can only prove self-consistency. |

**The unified root cause:** I designed from the *list of formats* instead of from the *shape of acquisition*.
Formats differ in how their metadata and payload are **obtained** — that is the axis that varies, and it is
the axis the abstraction must model.

## 2. The correct axis: how bytes and metadata arrive

Measured across all formats seen so far:

| Acquisition shape | Formats | What the adapter must be given |
|---|---|---|
| **A. Manifest + CDN list** | Modrinth `.mrpack`, CurseForge client pack | one archive (or provider ids) → file list with URLs |
| **B. Remote API, no archive** | FTB App (verified live), Modrinth-by-version | provider ids → metadata → file list |
| **C. HTTP tree, no container** | **packwiz** (measured) | a **base URL** → fetch `pack.toml` → `index.toml` → each `*.pw.toml` |
| **D. Real archive, no manifest** | author server pack, bare dump, wrapper zip | one archive → structural inspection + metadata inference |
| **E. Launcher instance** | Prism `mmc-pack.json`, ATLauncher `instance.json`, FTB local | a directory/archive that is a *client instance*; payload is local, not downloadable |

So the abstraction is wrong at the top: `PackAdapter.detect(ctx: {archive?|provider?})` assumed **A∪B∪D**.
It has no representation for **C** (a URL tree) or **E** (an instance whose payload is already local), which
is exactly where the failures clustered — packwiz (C) and Prism/ATL (E).

## 3. What this means for each piece of the current code

| Component | Verdict from evidence |
|---|---|
| `PackRecipe` (files + sides + loader + mc + resolution) | **Keep.** It survived all six deviations unchanged; it is the right normalisation target. |
| `validateRecipe` (fail-closed contract) | **Keep.** It caught real problems (unsafe paths, invalid MC) and never wrongly rejected a real pack. |
| `AdapterRegistry` (priority + validated keys, throw-safe) | **Keep.** Detection-by-keys, not filename, is what made the three-`instance.json` case work. |
| `detect(ctx)` input model | **Replace.** It must model acquisition shape C (URL tree) and E (instance), not only archive/provider. |
| `packwiz` adapter | **Rewrite as C.** Archive support becomes a secondary code path. |
| `prism` / `atlauncher` adapters | **Downgrade to E3-labelled, and only usable when the instance payload is actually present.** They cannot be verified without a launcher-produced instance; claiming otherwise is what DE-4 warns about. |
| `plain.serverzip` adapter | **Replace with delegation** to the existing CurseForge inspector + metadata inference, which already handles wrappers and blank metadata. |
| `modrinth` adapter | **Missing — add**, as a thin wrapper over the existing, verified Modrinth path. |
| `toml.ts` (hand-written parser) | **Reconsider.** It parsed 6/6 real packs, so it works — but it is a subset parser whose failure mode is silent for TOML features it does not know. For packwiz (a live HTTP format with thousands of real packs) a hardened parser or a maintained library is the defensible choice; the "one runtime dependency" preference does not outrank correctness on a format this widespread. |
| Loader-build escalation (`loader-build.ts`) | **Keep.** Independently evidenced (fault injection exercised it; it recovered a bootable server). |
| `installRecipe` + override layers | **Keep the plan/side logic; verify the override extraction** against a real instance before trusting it. |

## 4. The architecture the evidence supports

Two orthogonal axes instead of one:

```
                 ┌───────────── acquisition ─────────────┐
   A manifest+CDN │  B provider API │ C HTTP tree │ D archive │ E instance
                 └──────────────────────────────────────────┘
                                  ↓
                        PackRecipe (unchanged)
                                  ↓
                     validateRecipe → plan → stage → boot
```

Concretely:

```ts
type AdapterInput =
  | { shape: 'archive';  path: string; index: ArchiveIndex }
  | { shape: 'provider'; kind: 'ftb'|'curseforge'|'modrinth'; ids: Record<string, unknown> }
  | { shape: 'httpTree'; baseUrl: string }          // ← the missing one (packwiz)
  | { shape: 'instance'; dir: string; index: ArchiveIndex };  // ← payload already local
```

Each adapter declares which shapes it handles; the registry only runs an adapter on a shape it accepts. That
makes DE-1 and DE-2 structurally impossible: a format that is not an archive simply cannot be handed an
archive.

**Delegation rule (fixes DE-3):** where a verified implementation already exists in the codebase, the adapter
must *call* it, not re-implement it. Concretely, `plain.serverzip` and `curseforge.*` adapters delegate to
`inspectStagedZip` / `installCurseforge`, and the new `modrinth` adapter delegates to `resolveMrpack` /
`installModrinth`. The adapter's only job is: **recognise, normalise to `PackRecipe`, and delegate the
execution to the engine that is already proven.**

This also means the adapter layer is a *router and normaliser*, not a second installer. That is the cheapest
thing to verify and the least likely to regress working behaviour.

## 5. Correct verification strategy (fixes DE-4)

Per format, in this order — and no format may be called supported before step 3:

1. **Real corpus census.** Enumerate a real population (FTB: 92 packs via API; packwiz: 2,576 via GitHub code
   search; CF server packs: whatever the live API returns). Measure the value-space as data.
2. **Real-artefact resolve sweep.** Run the adapter over N real artefacts; record pass/fail as evidence files.
3. **Real end-to-end install + verified boot** for at least one artefact per format.
4. **Only then** label supported (E2+), with the evidence file named.

Formats that cannot reach step 3 (Prism, ATLauncher — need a launcher-produced instance) stay labelled
**E3, unverified**, explicitly in the UI/report, and are not offered as a supported install source until an
instance is obtained.

## 6. Revised, evidence-ordered plan

| Phase | Work | Exit criterion (evidence, not opinion) |
|---|---|---|
| **B0 — honesty** | Label current state: FTB E1/E2; packwiz E2− partial; Prism/ATL/serverzip E3; modrinth missing | doc + code comments state grades; nothing claims more |
| **B1 — shape model** | Add `AdapterInput.shape` (`archive`/`provider`/`httpTree`/`instance`); registry filters by declared shapes | unit: an archive can never be passed to a `httpTree` adapter |
| **B2 — modrinth adapter** | Thin wrapper over existing `resolveMrpack`, so `.mrpack` routes through the registry with **identical** behaviour | real 2 `.mrpack` files resolve; field-by-field identical recipe vs current path |
| **B3 — packwiz as httpTree** | Fetch `pack.toml`/`index.toml`/`*.pw.toml` over HTTP; discover `pack.toml` **or** `modpack.toml`, at root or in a subdirectory | ≥5 real packs resolve; GT:Modern (86 metafiles) and Project-CBT (126) fully enumerate |
| **B4 — delegate D** | `plain.serverzip` delegates to the existing CF inspector/inference | all 4 cached CF server packs resolve, incl. the 1 GB wrapper |
| **B5 — E-format honesty** | Prism/ATL: labelled E3, usable only when payload is present | documented, not claimed |
| **B6 — wire pipeline** | Route through registry for E2 formats only; existing paths untouched for the rest | 12-pack matrix still 12/12 |

## 7. What I will not do

- Rewrite all adapters at once. B1 changes the contract; B2–B4 are separate, individually verifiable steps.
- Commit the current P1c code as-is; it stays uncommitted until B1–B4 give it evidence.
- Add a format to the "supported" list without step 3 of §5.

## 8. The reusable lesson (for the record)

> The abstraction must be built on the axis that actually varies in the problem, and that axis can only be
> discovered by examining real instances of the problem — not by enumerating what the code currently handles.

Formats were a red herring. **Acquisition shape** is the real axis, and it was visible all along in the fact
that packwiz installer reads HTTP while CurseForge reads a manifest — I had even documented that fact in
doc §3 of the original research and still designed an "archive" abstraction.
