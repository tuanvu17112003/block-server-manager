# 14 — Provenance of every fix made today: which came from the reference, which did not

- Date: 2026-10-29
- Question asked: "are all the design changes based on the research and modules in
  `H:\TestAI\modrinth-curseforge`?"
- Honest answer: **mostly yes, but not all.** Two fixes are genuine additions *beyond* the reference,
  one is a deviation *from* it, and one contradicts an explicit reference rule. This file records the
  evidence for each so the distinction is not lost.

## A. Directly derived from the reference (quote → code)

| # | Fix today | Reference source | Verdict |
|---|---|---|---|
| 1 | Install-time L2 jar scan + L3 auto-fix loop before publish | `client-mod-method-research.md:18-19,66-77` (4-layer defense), `sample/modrinth.mjs:107-138`, `sample/curseforge.mjs:195-201` | **From reference** (ported; the app simply had not wired it into the install transaction) |
| 2 | Explicit include set — a curated exclusion is never treated as a user approval | `sample/modrinth.mjs:79-81` (skip when `env === 'unsupported'`), `client-mod-method-research.md:71-73` (force-include direction from itzg #4288) | **From reference behaviour** (the app's `!== 'exclude'` predicate had no counterpart in the spike) |
| 3 | Community force-includes are required, never a user conflict | `client-mod-method-research.md:27-30` (itzg `globalForceIncludes` `/(^|/)s-lib-/`), `curated.ts` parity | **From reference** |
| 4 | L4 curated data byte-identical + resolver parity | `sample/data/itzg-*.json`, `sample/env-overrides*.json`, `sample/core.mjs:534-542` | **From reference** (verified 565/565 identical verdicts) |
| 5 | CF prune-only vs Modrinth fetch in L3 | `modpack-install-results.md:70` ("CurseForge prune-only"), `sample/curseforge.mjs:198` | **From reference** |
| 6 | Prebuilt-pack detection (M-9) | `serverpack-tools.md:74-76`, `specs.md:390` (M-9) | **From reference** |
| 7 | Never execute bundled pack scripts (only `java -jar` / `java`) | `serverpack-tools.md:120,161`, design `:184`, `specs.md:220` | **From reference** |
| 8 | 2 req/s CF cap, no `Range` on keyless host | `curseforge-policy.md:128`, design `:144` | **From reference** |

## B. Additions beyond the reference (the reference never specifies them)

| # | Fix today | Why it is not from the reference | Basis |
|---|---|---|---|
| 9 | **Forge build from `promotions_slim.json`** when a pack pins none (RLCraft) | The spike has no promotions lookup: `sample/core.mjs:251-257` builds `forge-${mc}-${ver}` and would emit `1.12.2-undefined`. The spike passed RLCraft only because it resolved `loaderVersion` from the **client manifest** (route B: sidecar shows `loaderVersion: 14.23.5.2860`). Our route-A flow has no such manifest, so the build had to come from somewhere. | Forge's own canonical "recommended/latest" feed — authoritative provider metadata, but an **addition**, not a port |
| 10 | **Nested-ZIP server pack unwrapping** (Prominence CF: one `.zip` + `readme.txt`) | ADR-0013 (this app's own decision) requires it; the reference `serverpack-tools.md` and `sample/curseforge.mjs` never mention this shape and the spike never hit it (it used route B for that pack: sidecar `installed: 576`, 103 client-only) | App ADR-0013:14, *not* the reference folder |

## C. Deviations from the reference

| # | Fix today | Reference says | Verdict |
|---|---|---|---|
| 11 | **Route selection for key-mode CurseForge**: the app downloads the author server pack (`serverPackFileId`) and installs route A; only falls back to the manifest | design `:138` "**Prefer the manifest (client pack)** per the itzg rationale"; `serverpack-tools.md:142` "**Prefer manifest (client pack) over prebuilt server pack when both exist**: the manifest is machine-readable, server packs drift" | **Deviates.** The app is faster (no per-file resolution) but inherits exactly the drift the reference warns about — this is why Prominence CF needed the nested-ZIP unwrap, the SPC-manifest guard and the promotions lookup in the first place |
| 12 | **MC version from multi-tag `gameVersions`**: `pickMinecraftVersion()` chooses the highest stable `x.y.z` | Reference only says "validate `gameVersions[]` against the pack's MC version and loader" (`specs.md:218`, `modpacks.md:64`); it never had to pick among `1.18.1/1.18/1.18.2/1.18-Snapshot` because the client manifest carries one exact `minecraft.version` | **Reasonable extension of a reference rule**, not a port. Without a manifest (route A) the rule "take the pack's declared MC" is under-specified, and the first-tag behaviour was demonstrably wrong (DawnCraft) |
| 13 | **Loader inferred from sibling files when the newest CF file lost its `Forge` tag** (RLCraft) | Reference has no such rule; it never reads loader tags off the newest file, it reads the manifest | **Addition**, evidence-based (2 sibling files on 1.12.2 both tag Forge), and it still fails closed when no sibling agrees |

## D. What the reference explicitly requires and the app still does NOT do

These are unaffected by today's work and remain open (see [12-reference-conformance-audit.md](12-reference-conformance-audit.md) §B):

1. Optional mods default **off** with a checkbox (design `:105-106`) — the app defaults **on**.
2. Keyless CurseForge must be an **explicit opt-in** naming the posture (design `:115-117`, `curseforge-policy.md:126`) — the app runs keyless silently.
3. **Update flow** (re-resolve → diff → swap) + a sidecar able to diff (design `:33,110-111`) — absent.
4. **Manually-required panel** with page links (A-2, design `:173`, `modpacks.md:67`) — flattened to warning text.
5. **Script-driven** server pack: parse YAML or ask consent (design `:131-133`, plan T13) — rejected as unsupported.
6. **L3 budget** 15 min / 8 rounds (`sample/core.mjs:339,425`) — app uses 8 min / 6 rounds.
7. Learning must be **read at install time** so pack A teaches pack B's downloads (`sample/core.mjs:519`) — app only reads it at server start.
8. **Per-file progress + resume** (design `:30,85`) — byte counters never populated; `.part` deleted on failure.
9. Route C is optional/last phase in the reference, but this app shipped it — an extra, not a gap.
10. The reference's CurseForge acceptance packs were installed by **route B (manifest)**; this app installs most of them by **route A (server pack)**. Both reach `Done (`, but they are not the same code path, so per-pack parity is outcome-parity, not path-parity.

## E. Bottom line

- The **4-layer client-mod defense, curated data, prune-only policy, verified boot and safety rules**
  are faithful ports of the reference — verified by reading both sides and by running the spike's own
  resolver against the app's over a real pack (565/565 identical verdicts).
- Fixes 9, 10, 12 and 13 are **not** from the reference; they exist because the app's CurseForge path
  takes the server-pack route the reference deprioritised, and that route carries defective/absent
  metadata. They are implemented as fallbacks that still fail closed.
- One real **deviation from an explicit reference recommendation** is fix 11 (server pack preferred over
  the manifest). Reversing it would align the app with `serverpack-tools.md:142` and remove several
  edge cases — this is a product decision, not a bug fix.
