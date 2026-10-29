# 12 — Reference conformance audit: `H:\TestAI\modrinth-curseforge` vs this app

- Date: 2026-10-29
- Question: does the app implement what the approved research/design folder actually specifies?
- Method: read every reference doc (`modpack-install-design.md`, `modpack-install-plan.md`, `specs.md`,
  `client-mod-method-research.md`, `curseforge-policy.md`, `serverpack-tools.md`,
  `modpack-install-results.md`) and the `sample/` spike source, then trace each claim to real code with
  line-level evidence. Policy verdicts additionally re-executed: the spike resolver and the app resolver
  were run side by side over the real Prominence mrpack (`scripts/check-l4-parity.mjs`).
- Verdict: **the 4-layer defense matches; the surrounding product contract does not, in 12 places.**

## A. Verified MATCH (no action)

| Item | Reference | App | Evidence |
|---|---|---|---|
| L1 `env.server` read + default | `modrinth.mjs:79-81` | `installer/modrinth.ts:299-311` | same `?? 'required'`, same skip set |
| L2 detection rules | `core.mjs:462-492` | `installer/core.ts:1095-1120` | identical regexes incl. "every `side=` must be CLIENT" |
| L2 protect set + reversible move | `modrinth.mjs:108`, `core.mjs:503` | `pipeline.ts:612`, `core.ts:1131` | same `mods-disabled/` rename, force-includes protected |
| L3 attribution rules | `core.mjs:393-424` | `core.ts:1027-1055` | byte-identical incl. `handler$…$ns$` mixin rule |
| L3 order (disable → fetch) | `core.mjs:437-452` | `core.ts:1072-1087` | same |
| L3 Modrinth fetch / CF prune-only | `modrinth.mjs:110-131`; `curseforge.mjs:198` | `modrinth.ts:97-132`, `pipeline.ts:672`; CF `pipeline.ts:705` | same |
| L4 curated data bytes | `sample/data/*.json`, `sample/env-overrides*.json` | `installer/data/*.json` | SHA-256 identical on all 4 |
| L4 precedence + `unlessPresent` | `core.mjs:534-542` | `curated.ts:45-54` | identical |
| L4 verdict parity (real pack) | spike resolver | app resolver | **565/565 identical verdicts, same 351-file install set, same protect set** (`scripts/check-l4-parity.mjs`) |
| Verified `Done (` before publish | `specs.md:391-392` (M-10) | `install-transaction.ts:344-368` | gate exists on both install paths |
| No `Range` on keyless host | `specs.md:198-200` | `core.ts:203` (no Range anywhere) | match |
| 2 req/s CF cap | `curseforge-policy.md:128` | `core.ts:166-173` | match |
| Never execute bundled pack scripts | `serverpack-tools.md:120`; design `:184` | only `java -jar` / `java` spawns (`core.ts:649-656`, `:979`) | match; shipped `forge-*-installer.jar` run is explicitly sanctioned |
| Route C sandbox | `specs.md:221-223` | `curseforge-staging.ts:118-141` | match (ahead of its optional phase) |
| Staging + rollback + cancel | design `:96`; M-7 | `install-transaction.ts:279-392` | match |
| Modrinth sha1/sha512 verify | design `:107` | `modrinth.ts:313-317` | match |
| Key in `safeStorage`, never logged | design `:139-140` | `secrets.ts:50-56` | match |
| Prebuilt server pack detect (M-9) | `serverpack-tools.md:74` | `curseforge.ts:274-291` | match |

## B. Divergences (each changes behaviour)

| # | Reference requirement | App behaviour | Verdict |
|---|---|---|---|
| 1 | Optional mods default **off** + checkbox (`design:105-106,222,231`; `specs:209`) | default **on** (`pipeline.ts:284-287` `optionalDefaultKeep`, `helpers.ts:125-131`, `PipelineReview.tsx:68`) | DIFFERENT — inverted. Deliberate in ADR-0013 ("optional entries stay included by default") but contradicts the reference design |
| 2 | Update flow: re-resolve → diff → swap (`design:33,110-111` G-E) | no pack-update code or IPC; sidecar has no hashes/version/file IDs; CF `files: []` (`pipeline.ts:680-684,707-710`) | GAP — the reference's update design cannot be built on this sidecar |
| 3 | "Every run teaches the next" (`client-mod-method-research.md:76-77`) | `appendLearned` writes `<dataRoot>/state/…`, but install-time resolvers never pass `learnedFile` (`pipeline.ts:447,668,784`), so only the frozen bundled file is read | DIFFERENT — learning affects later *starts*, not later *downloads* |
| 4 | Spike records `l2Disabled` in the sidecar (`modrinth.mjs:103,108`) | `startWithAutoFix` returns `l2` (`core.ts:1061,1064`); `pipeline.ts:616-618` discards it; no `l2Disabled` anywhere | GAP — users cannot see why dozens of jars were moved |
| 5 | L3 budget: 15 min, 8 rounds (`core.mjs:339,425`) | install loop 8 min / 6 rounds (`pipeline.ts:610-611`); runtime loop 8 rounds with **no timeout** (`server-process.ts:318`) | DIFFERENT — big packs can miss the verify window; hung boots never reach L3 |
| 6 | Learn once, after the loop proves success (`modrinth.mjs:135`) | runtime appends per round **before** success (`server-process.ts:361-371`) | DIFFERENT — poisoned learned file for unattributed crashes |
| 7 | Keyless = explicit opt-in, mode banner (`curseforge-policy.md:126,132`) | keyless is the silent default; only a Settings hint (`secrets.ts:103`) | GAP — the highest policy risk |
| 8 | Official API first when a key exists, incl. publisher `hashes[]` (`curseforge-policy.md:125`; design `:117-120`) | official API only for project→`serverPackFileId`; route-B metadata stays keyless (`curseforge.ts:47-57`) | DIFFERENT — the sanctioned integrity upgrade is unused |
| 9 | CF keyless integrity = size + persisted self-computed SHA-256 (`curseforge-policy.md:114-117`) | size checked (`curseforge.ts:71-74`); hash computed then discarded | GAP — half the scheme |
| 10 | Unfetchable file → **manually required panel** with page link (A-2, `design:173`; `modpacks.md:67`) | `manuallyRequired` produced (`curseforge.ts:475`) then flattened to warning text (`pipeline.ts:696`); URL is a synthetic `mc-mods?fileID=` search | GAP — no panel, non-actionable link |
| 11 | Route A classifies prebuilt / **script-driven** / plain, script-driven → parse YAML or ask consent (design `:131-133`; plan T13) | only `clientExport`/`supportedServerPack`/`unsupported` (`curseforge.ts:222`); script-driven → `unsupported` | GAP — a whole reference shape is unimportable |
| 12 | Prebuilt = `libraries/` **and** run script, or launch jar (`serverpack-tools.md:74`) | `user_jvm_args.txt` alone ⇒ "Prebuilt" in preview (`curseforge.ts:239,262`) while the installer test at `:278-291` disagrees | DIFFERENT — preview and install disagree |
| 13 | M-10 "unless the user opts out" (`specs:391-392`) | verification is enabled by EULA acceptance, not a user toggle; declining EULA ⇒ publish unverified | DIFFERENT — the opt-out is not a choice |
| 14 | Overrides never overwrite world dirs, `whitelist.json`, `banned-*`, `ops.json` (`design:108-109`) | `PROTECTED_OVERRIDE_PATHS = ['eula.txt','server.properties']` (`modrinth.ts:153`) | DIFFERENT — narrower than specified (world preservation relies on `skipExisting`) |
| 15 | Wizard: 5 screens incl. dedicated EULA + console; i18n en/vi (design `:171-176`, G-D) | 4 steps, EULA inline checkbox, console is a separate tab; no locale layer | DIFFERENT / GAP — declared out of scope in the app plan |
| 16 | Per-file progress + resumable retry (design `:30,85`) | `bytesDownloaded/bytesTotal` declared but never populated (`jobs.ts:2-3`); progress every 25 files; `.part` deleted on failure (`core.ts:246-250`) | GAP |
| 17 | ADR-0014/0015 (app's own accepted decisions): Fabric `depends.java` + missing hard-dependency preflight before publish | Rust had both (`legacy/.../modpacks/install.rs:1038-1123`); the Electron port has neither (tracked as a WP-4.8 follow-up) | GAP vs the app's own ADRs — the 4-layer L3 covers it at boot instead |

## C. Result parity vs `modpack-install-results.md` (12/12 PASS)

Reference recorded real `Done (` for 12 packs. The app has real `Done (` evidence for **3 distinct packs**:

| Reference pack | App evidence |
|---|---|
| Prominence II CF | YES — `Hasturian2CurseForge` (327 jars, 21 L2-disabled, `Done (12.592s)`) |
| (Craft to Exile — not in reference matrix) | YES — `CrafttoExile` (`Done (13.170s)`) |
| Cobbleverse | YES — `e2e-cobbleverse` + `CobbelMon-Modrinth` (`Done (1.697s)` / `Done (1.128s)`) |
| Prominence II Modrinth | Reproduced this session through the real pipeline (`scripts/verify-prominence-fix.mjs`, 348 jars, 15 disabled, verified boot) but the older installed server `Test` has no `Done (` in its log |
| SkyBlock Enhanced, BattleArmory TACZ, Slimes Adventure, Zombie Invade | **NO EVIDENCE** |
| Dungeon Heroes, RLCraft, SkyFactory 5, DawnCraft, Otherworld D&D | **NO EVIDENCE** (SF5 key-mode e2e exercises download/classify only, no sidecar/boot) |

So "matches the reference's 12/12" is **not proven** on this side. What is proven: the shared engine
that produced the reference's 12/12 is ported faithfully (section A), and the app's own verified installs
reach `Done (` — this session added SF5 (installer route) and a prebuilt 1.0 GB Forge pack.

## D. Prior claim corrected

`docs/audit/03-installer.md` and one audit subagent flagged a route-A EULA bypass (a pack-shipped
`eula.txt` surviving because `writeEula` only writes when absent). **Not reachable in practice**:
`install-transaction.ts:319-323` always calls `writeEulaFile(dir, accepted)` after the installer callback,
and that function unconditionally rewrites or deletes the file (`properties.ts:358-374`). Both pipelines
pass `enforceManagerConfig`. No action needed.

## E. Ranked work if full conformance is required

1. D-25 keyless opt-in gate + mode banner (policy risk, cheap).
2. Optional-mod default: pick one authority — reference says OFF, ADR-0013 says ON; document the winner.
3. Pass `learnedFile` to install-time resolvers; make learning post-success only.
4. Record L2 disables in the install report/sidecar.
5. Align L3 budget with the reference (15 min / 8 rounds) and give the runtime loop a timeout.
6. CF: persist self-computed SHA-256; use publisher hashes when a key exists; manual-required panel.
7. Script-driven pack classification + consent flow.
8. Update flow + a sidecar that can actually diff (hashes, version/file IDs, CF file list).
9. ADR-0014/0015 preflights (or formally supersede them with the L3-decides rationale).
10. Broaden `PROTECTED_OVERRIDE_PATHS`; real per-file/byte progress; resume.
