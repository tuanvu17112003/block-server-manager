# 10 — Prominence II (Modrinth) install failure: root cause, reference parity, fix

- Date: 2026-10-29
- Symptom: installing **Prominence™ II: Hasturian Era v4.1.5hf** (Modrinth, MC 1.20.1, Fabric) through the
  wizard ended in `INSTALL — NEEDS ATTENTION`: boot verification failed with
  `Mod 'Drippy Loading Screen' (drippyloadingscreen) … requires fancymenu, which is missing` (and the same
  for `welcomescreen`), exit code 1 before `Done (`. The staged tree was rolled back (correct) and the
  install report showed `needs-attention`.
- Reference: `H:\TestAI\modrinth-curseforge` (`modpack-install-results.md`, `client-mod-method-research.md`,
  `sample/modrinth.mjs`) records this pack as **PASS `Done (37.310s)!`** on the 4-layer pipeline. Our
  implementation did **not** match that experiment in three places.

## Root causes

1. **Install-time include set was computed inverted.**
   `pipeline.installInner` passed `includeOptional: filePath => choices.files[filePath] !== 'exclude'`.
   `resolveModrinthFilePolicy` treats `userIncluded` as "the reviewed plan explicitly keeps this file, so
   curated exclusions may be overridden". With the inverted predicate **every** curated exclusion that had
   no per-file choice became "user included". Measured on the real pack: 565 files installed instead of
   351; `drippyloadingscreen` and `welcomescreen` (curated/learned `unsupported`) were installed, while
   `fancymenu` — a review conflict the user excluded — was not. Hence the exact missing-dependency crash.
   The reference spike skips `curated.env === 'unsupported'` unless the reviewed plan explicitly overrides
   that path; it never treats "not excluded" as "included".
2. **Install verification was a single un-assisted boot.**
   `install-transaction` verified installs with one `startAndVerify` call. The reference uses its L2
   (jar self-declaration scan) followed by the L3 boot-decides loop (`startWithAutoFix`: crash/log
   attribution, reversible `mods-disabled/`, Modrinth dependency fetch, retry) **before** reporting
   success. Our L2/L3 existed, but only at runtime `server_start`, not inside the install transaction.
3. **Force-included dependencies were offered as user conflicts.**
   `env-overrides` / itzg `globalForceIncludes` entries (`s-lib`, `SimplyTooltips`) are evidence-backed
   required mods; `mapFilePolicy` still saw `env.server=unsupported` vs `curated.required` and produced
   `awaitingUserChoice`. Prominence presented 5 conflicts, 2 of which were force-includes that must never
   be excludable.

## Fix (all generic, no per-pack branches)

| File | Change |
|---|---|
| `electron/services/pipeline.ts` | New `resolveIncludedPaths(decisions, choices)`: only explicit `include` or `optionalDefaultKeep` counts as user-approved. Installer passes computed `includeFiles`/`excludeFiles` (explicit plan exclusions beat curated verdicts); force-include protection is passed to `mapFilePolicy` and yields `required`, rejecting an explicit Exclude. Verified boot now runs `startWithAutoFix` with L2 protect set + Modrinth `fetchModrinthDependency` (CurseForge stays prune-only), records every fix in the report (`disabled-by-autofix`/`added-by-autofix`), appends learned disables to `<dataRoot>/state/env-overrides-learned.json`, and reports rounds. |
| `electron/services/installer/modrinth.ts` | `InstallModrinthOpts` now takes explicit `includeFiles` / `excludeFiles` sets (no ambiguous predicate); curated-excluded files without an explicit include are skipped; plan exclusions are honoured before curated policy; result reports `skippedUserExcluded` and `installedPaths`. |
| `electron/test/unit/pipeline-decisions.test.ts` | Regression tests: force-includes are required and cannot be excluded; `resolveIncludedPaths` never includes a curated exclusion unless the plan chose Include. |

## Verification against the reference experiment

| Reference behaviour (`H:\TestAI\modrinth-curseforge`) | Before | After |
|---|---|---|
| L2 jar self-declaration scan before first install boot | runtime start only | inside staged verify |
| L3 boot-decides loop with reversible `mods-disabled/` | not at install (single boot) | 6-round loop at install |
| Modrinth missing hard dependency fetched (CF prune-only) | runtime only | install loop, Modrinth only |
| Explicit plan Include overrides curated exclusion | inverted: everything included | explicit only |
| Community force-includes stay required | shown as conflicts | required, non-excludable |
| Learned disables accumulate for future packs | runtime only | install loop appends too |

## Evidence (real app pipeline, no mocks)

**Durable artifact:** [`docs/evidence/prominence-modrinth-install.json`](../evidence/prominence-modrinth-install.json)
(written by the harness itself before its throwaway data root is deleted — an earlier version of this doc
cited numbers no artifact supported; that gap is now closed).

- Real cached pack `Prominence™ II Hasturian Era v4.1.5hf.mrpack` (407.9 MB) through `Pipeline.preview` →
  `Pipeline.install` with real Java 17 and a throwaway data root:
  - plan: **351 include / 211 exclude / 3 conflicts** (was 565 included / 0 excluded in the bug build)
  - conflicts: `PickUpNotifier`, `fancymenu`, `ForgeConfigScreens` (the force-includes no longer appear)
  - install: `status=complete`, `verify-boot` completed with **1 auto-fix in 2 rounds**
    (`chipped-fabric-3.0.7.jar` disabled by L3 after L2 disabled 14 self-declared client jars)
  - published server: **348 jars enabled, 15 disabled**; no rollback; 211 unsupported + 3 plan-excluded skipped
- Repro harness: `node scripts/verify-prominence-fix.mjs <.mrpack> prominence-2-fabric` (kept in repo).
- `node scripts/unit.mjs`: **261/261 pass**.
- `npm run verify`: **PASS 10/10**.
- Rebuilt package + installer: `npm run pack:win` → `release/Block-Server-Manager-0.2.0-Setup.exe`
  (116.0 MB, SHA-256 `FB5182752ADD566935CC5295402F94A0555C030901967ABD0E9216D2D97E9340`);
  `pack:verify` **PASS 3/3**, `pack:verify:installer` **PASS 6/6**.

### Scope note (what this run does and does not prove)

It proves the engine fix on the Prominence Modrinth source (the failing pack from the report). It does
**not** constitute matrix-level parity with the reference's 12/12 live sweep — see
[12-reference-conformance-audit.md](12-reference-conformance-audit.md) §C for which packs still lack
app-side evidence.

## Notes

- The 3 remaining conflicts are genuine `env.server=required` vs curated-exclude contradictions; the UI
  requires an explicit Include/Exclude, and the reference's `env-overrides` data explains why they are
  listed. Excluding them now also excludes their dependents correctly (no missing-dependency crash).
- CurseForge Prominence previously passed install verification (staged CF run) because CF prune-only keeps
  its dependency set internally consistent; the Modrinth route was the broken one.
