# Research doc vs implementation: complete conformance diff

- Date: 2026-10-29
- Subject: [2026-10-29-universal-modpack-install.md](../research/2026-10-29-universal-modpack-install.md) —
  the design written **before** any adapter code existed.
- Why this comparison matters more than the others: the research doc is the only artefact that predates the
  implementation. Every deviation from it is a place where I **contradicted my own evidence-based design**
  while coding. The previous audits compared code to *reality*; this one compares code to *my own written
  specification*, which is a different and sharper test.
- Result: **11 deviations**. Six are things the research explicitly specified and the code did not do. One is
  a place where the code is *better* than the research. Four are research claims that later evidence
  corrected.

---

## 1. Deviations where the research was RIGHT and the code did not follow it

### RD-1 — `PackAdapter.id` union dropped most formats (research §6 line 280)

**Research spec:**
```ts
readonly id: 'modrinth' | 'curseforge' | 'serverpack' | 'packwiz' | 'ftb' | 'atlauncher'
            | 'prism' | 'gdlauncher' | 'technic' | 'mcbbs' | 'hmcl' | 'bare';
```
**Implemented:** `PackFormatId` allows 13 names, but the **registered** adapter list is
`[packwiz, prism.multimc, atlauncher, ftb.app, plain.serverzip]` — **`modrinth` and `curseforge` are absent**.

The research's own P1 line (347-348) is explicit:

> *"First adapters: `modrinth`, `curseforge`, `serverpack`, `bare` (covers everything the app does today, via
> the new path, so no regression), then `packwiz`, `prism`, `atlauncher`, `ftb`, …"*

I inverted the stated order exactly. The research said **cover what works first, so no regression, then add
new formats**. I added new formats first and never covered the working ones. This is the direct cause of
Phase-A deviation D1 (both real `.mrpack` files unclaimed).

### RD-2 — Detection contract mismatch (research §6 line 283 vs implemented `DetectContext`)

**Research spec:** `detect(files: ArchiveIndex, meta: ProviderMeta): boolean` — detection is handed both the
archive *and* provider metadata.

**Implemented:** `detect(ctx: { archive?: ArchiveIndex; provider?: { kind; ids } })`. Functionally close, but
the research implies every adapter sees both signals; the implementation makes them exclusive in practice
(`ftb` uses `provider`, everything else uses `archive`). This is the seed of DE-2 in doc 21: the contract
never anticipated a format (packwiz) whose natural input is **neither** an archive nor a provider id, but a
URL.

The research did document packwiz's nature correctly (§2 row 7: *"`pack.toml` + `index.toml`"*), and §3.9 of
the same research (added later) says packwiz-installer *"reads only `pack.toml` over HTTP and nothing else, so
any host/CDN/CI can serve a pack"*. So the fact was known and written; the interface silently excluded it.

### RD-3 — Pipeline step 2 "Normalize" was never implemented in the adapter layer (research §6 line 305)

**Research spec, step 2 of the nine-step pipeline:**
> *"**Normalize** — list entries once; unwrap single nested zip; strip a single wrapping directory; record an
> `ArchiveIndex`."*

**Implemented:** `buildArchiveIndex` does the listing only. No nested-zip unwrap, no wrapping-directory strip.

**Consequence measured in Phase A:** the real 1 GB CurseForge wrapper archive
(`466901-server-9296268.zip`, 2 entries: one nested zip + readme) is claimed by **no adapter**. The research
anticipated exactly this and put normalization *before* detection. I skipped it and the case failed.

Note the irony: the existing `curseforge.ts` has `findNestedServerPackZip` (lines 276, 295, 477) — the
capability the research asked for exists in the codebase, just not in the layer that needed it.

### RD-4 — §7 gap 3 (Forge `mods.toml` side rule) still unfixed, though the research proved it wrong

**Research §3.1** established with source quotes that SPC reads the `side` on the **platform dependency**
(`modId ∈ {forge, neoforge, minecraft}`), and that our "every `side=` is CLIENT" predicate is a *different
predicate* which can both miss client mods and mis-disable server mods.

**Current code** (`core.ts:1124`): `if (sides.length && sides.every(s => s === 'CLIENT'))` — unchanged. The
research proved this wrong *before* the adapter work began; it survived three phases and 328 tests.

### RD-5 — §7 gap 4 (dependency rescue) still absent

**Research §3.4** quoted SPC's `ModListCompiler` rescue loop (matching dependency id **and** the jar's
`provides` aliases, because `fabric-api` provides `fabric`), and ranked it among the highest-value generic
mechanisms.

**Current code:** grep for `rescue|dependents|provides` across `installer/*.ts` → **zero hits**. We still
compensate with hand data (`unlessPresent`), which is the per-pack approach the research said to replace.

### RD-6 — §7 gap 5 (unanchored hand/learned matching) still unfixed

**Research §3.6** documented itzg's `figura`/`configurable` silent over-exclusion and stated the rule:
*"anchored/regex matching, never bare substring"*, while noting correctly that our **itzg lists** already go
through the anchored `entryTest` and only hand+learned are bare.

**Current code** (`curated.ts:45,48`): `n.includes(norm(o.match))` — unchanged. Also still no rule id logged.

Also unfixed from the same table: **gap 7** (learned file not read at install time — grep for `learnedFile` in
`pipeline.ts` → zero hits) and **gap 9** (no persisted diffable file manifest; the sidecar still stores
`files: paths` for Modrinth and `files: paths` for recipes, with no hashes/sizes, so it cannot drive a diff or
a safe cleanup).

---

## 2. Deviation where the implementation is BETTER than the research

### RD-7 — The research under-specified loader-build resolution; the code added a correct policy

**Research §4** said only: exec the loader-generated args file, and take Java from Mojang metadata. It said
nothing about *which loader build* to install when a pack declares none.

The implementation added `installer/loader-build.ts` with:
- a declared build is authoritative and never overridden;
- candidates come from Forge's own `recommended`/`latest` feed (NeoForge has no equivalent → fails closed);
- **only** a loader-level boot failure may escalate, and mod-level evidence vetoes it;
- hard budget, and rule-attributed refusal.

This is genuinely beyond the research, and it is independently evidenced (fault injection exercised the
escalation branch and recovered a bootable server; FTB Omnia installs because of the version-selection fix
that accompanied it). **Recorded as an addition, not a deviation to fix.**

---

## 3. Research claims that later evidence CORRECTED (the research was wrong, not the code)

These came from the Phase-A audit and the FTB census; they are listed here because a conformance diff must run
both directions.

| # | Research claim | Corrected by evidence |
|---|---|---|
| RC-1 | §1 line 25-27: the gap is *"detection by source kind, not by archive contents"* | The real gap is broader: **acquisition shape** (manifest+CDN / provider API / HTTP tree / archive / local instance). Archive-content detection is only one shape, and it is the wrong abstraction for packwiz (HTTP tree) and Prism/ATL (local instance). |
| RC-2 | §2 row 7: packwiz signature is `pack.toml` | Real packs also use **`modpack.toml`**, and the pack file may sit in a **subdirectory** (`Packwiz/1.21/pack.toml`, measured). |
| RC-3 | §6 line 273-274: *"Each adapter is pure (reads an archive or provider API…)"* | This is where the design narrowed wrongly. packwiz reads an **HTTP tree**; Prism/ATL read a **local instance**. "archive or provider API" excludes two of the five shapes that actually exist. |
| RC-4 | §9 line 389: T0 fixtures are the primary proof of detection correctness | Phase A falsified this. 25 fixtures passed while a **whole format was missing** and a real pack was **invisible**. Fixtures prove self-consistency; only real artefacts prove correctness. The research's own tier list put T0 as the foundation — the evidence says T0 must be the *last* tier, after real-corpus and real-artefact sweeps. |

---

## 4. What the research got right and the code kept faithfully

Worth recording, because the picture is not uniformly bad:

| Research element | Implementation status |
|---|---|
| `PackRecipe` field set (`mc`, `loader`, `loaderVersion`, `javaMajor`, `files`, `overrides`, `launch`, `state`, `warnings`) | Implemented faithfully (renames: `launch`→`launchShape`, `state.managerOwned`→`managerOwned`); **survived all six real-artefact deviations unchanged** |
| `Side` tri-state with `unknown` first-class (§6 line 277) | Implemented, and honoured end-to-end: `planRecipeFiles` installs `unknown` as a server candidate rather than excluding it |
| Priority-ordered detection with validated keys, never extension (§2 line 57) | Implemented, and it is what made the three-`instance.json` case work (ATL vs FTB vs vanilla launcher) |
| "No match ⇒ explicit `unsupported` with the reason and the evidence checked, never 'unknown pack'" (§6 step 3) | Implemented with entry-count + root-file evidence in the message |
| Manager-owned state protection (§6 step 7) | Implemented in `planRecipeFiles` and in the override-extract filter |
| Boot as the decider; only crash-proven exclusions published (§5 ranked list #4) | Pre-existing, retained, and wired for adapter installs via `autoFixContext` |
| `RuleAttributed` warnings (§6 line 298) | Implemented: every warning carries a `rule` id, e.g. `ftb.duplicate-destination` |

---

## 5. Summary table

| # | Item | Research said | Code does | Severity |
|---|---|---|---|---|
| RD-1 | Adapter coverage order | modrinth+curseforge **first**, no regression | neither registered; new formats only | **critical** |
| RD-2 | detect contract | archive **and** provider meta | exclusive; no URL shape | high |
| RD-3 | pipeline step 2 Normalize | unwrap nested zip, strip wrapper, **before** detection | listing only; 1 GB wrapper unclaimed | **critical** |
| RD-4 | gap 3 Forge side rule | proven wrong, fix required | unchanged since research | high |
| RD-5 | gap 4 dependency rescue | required, quoted SPC impl | absent (0 hits) | high |
| RD-6 | gap 5 anchored matching + rule ids | required, quoted itzg incident | `includes()` unchanged | medium |
| RD-6b | gaps 7, 9 (learned at install; diffable manifest) | required | absent | medium |
| RD-7 | loader-build policy | not specified | **implemented, evidenced** | addition |
| RC-1..4 | research claims | — | corrected by evidence | research errors |

**Headline: the single largest deviation is RD-1.** The research stated the correct build order in one
sentence — *cover what works first so no regression* — and I did the opposite. Everything else in this
document is smaller than that one inversion, and it is the reason the adapter layer, as currently written,
would make the product worse if it were switched on.

---

## 6. Process pattern, now visible for the third time

| Audit | What it compared | Deviations found |
|---|---|---|
| doc 18 | code vs **FTB reality** | 5 (all data-shape assumptions) |
| doc 20 | code vs **real artefacts** | 6 (3 architectural) |
| doc 22 (this) | code vs **my own written research** | 11 |

Each audit found more than the previous one, and each found a *different class*: data shape → input model →
**specification conformance**. That ordering is itself informative: the cheapest check (does the code match the
design I already wrote?) was the one I never ran, and it would have caught RD-1 and RD-3 before any code was
written.

**Rule for the plan:** a specification-conformance check belongs *before* implementation, not after three
audits. The research doc was the specification and it was sitting in the repository unread while I coded.
