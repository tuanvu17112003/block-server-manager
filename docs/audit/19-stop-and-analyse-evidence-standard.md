# Stop-and-analyse: what actually happened vs what I claimed, and the verification layer that was missing

- Date: 2026-10-29
- Trigger: the operator stopped me mid-P1c with a correct observation — *"có lẽ chúng ta nên kiểm tra và phân
  tích lỗi thực tế so với phân tích trước… thay vì tìm thấy gì sửa đó như bây giờ"*.
- Status: **analysis only. No code was changed while writing this.** The P1c work in the tree is frozen and
  audited below; the plan at the end awaits agreement.

---

## 1. The uncomfortable inventory

I checked the actual state rather than trusting my own summaries.

| Artefact | What I said | What is true |
|---|---|---|
| P1c adapters (`packwiz`, `prism`, `atlauncher`, `serverzip`, `toml` — 919 lines) | (in progress) | Written, unit-tested **only against fixtures I invented** |
| `scripts/verify-packwiz-archive.mjs` | — | **Written but never executed.** Evidence file absent. |
| P1c real-archive evidence | — | **Zero.** No real packwiz/Prism/ATL archive has ever been through these adapters. |
| FTB work (P1/P1b/17/18) | "verified" | Genuinely verified: real API, 92 packs, real installs, real boots. |

So the honest split is: **FTB is evidenced; P1c is not.** And P1c's fixtures were authored by me *from the
schema I read* — which means if I misread the schema, the fixture and the parser are wrong together and the
tests pass. That is the exact failure mode the operator is pointing at.

This is also not a new mistake. It is the same mistake, one level up:

| Level | The mistake | Caught by |
|---|---|---|
| Bug level | Assume a field's shape, code it, be surprised | Running a second pack |
| Test level | Assume a format's shape, write fixture + parser together | Nothing — self-consistent |
| Process level | Fix what the last run reveals, in discovery order | This document |

## 2. Every bug so far, re-classified against what I had claimed

Seven bugs to date. I previously classified them by root cause (doc 18 §1). Re-reading them against the
*analyses I had written before them* gives a sharper picture:

| # | Bug | Which analysis was wrong or absent | Was the prior claim falsifiable? |
|---|---|---|---|
| 1 | 155 mods dropped (`path` is a directory) | I never analysed the FTB `path` field before coding — I analysed the **format list**, not the **field semantics** | No: doc 15 claimed "adapter verified" with no field inventory |
| 2 | Directory treated as file (EEXIST) | Same gap, opposite direction | No |
| 3 | Zero-byte config rejected | I asserted "empty file = error page" without checking if empty is legal | No |
| 4 | `versions[0]` = oldest | I wrote the comment "FTB lists newest first" — **a claim with no evidence**; it was false | No: comment, not measurement |
| 5 | Modded pack with no loader read as vanilla | I never asked "can a pack contradict itself?" | No |
| 6 | Classifier missed legacy Forge error | I wrote signature patterns from memory of what errors "look like" | No |
| 7 | Stale launch shape after reinstall | I never analysed the consequence of "artifact name encodes version" | No — but a 30-second consequence analysis would have found it |

**Pattern: every single bug came from an unfalsifiable claim.** A comment, a fixture, or a "verified" label
that could not fail. None came from a lack of care; all came from a lack of *disconfirming evidence*.

Doc 18 fixed this at the **data** level (census). But census only works when the truth is *observable in bulk*
— the FTB API was. For P1c the truth lives in archives I do not have, so I substituted my own fixtures, which
restores the original failure mode.

## 3. Root cause, stated precisely

> I keep verifying **that the code does what I designed**, instead of verifying **that my design matches
> reality.**

Design-conformance tests (fixtures I write) can only prove internal consistency. They cannot prove the design
is right. Evidence of correctness needs an input I did **not** author.

Three specific consequences:

1. **A fixture written from my reading of a schema cannot detect a misreading.** P1c's 25 tests would pass even
   if I misread Prism's `formatVersion` semantics — because both sides share the same misreading.
2. **"Verified" has been used at three different strengths** — real corpus / one real sample / my own fixture —
   without marking which. That is why the operator's question ("mọi thứ đã clean rồi phải không") deserved a
   "no" that I did not give clearly enough.
3. **Fixing in discovery order** produces local fixes and a growing unexamined surface: each pack taught one
   bug, so the code is shaped by whichever packs I happened to touch.

## 4. What the evidence standard should be (proposal)

Introduce an explicit, written evidence grade per capability, and never let a claim exceed its grade:

| Grade | Meaning | Example |
|---|---|---|
| **E1 — Real corpus** | Every instance in a real population processed, results recorded | FTB: 92/92 packs via `/modpack/all`, 83,177 files contract-checked |
| **E2 — Real input, sampled** | A genuine artefact of that format, produced by that format's own tool, successful end-to-end | FTB installs (Stoneblock 2, Academy, Omnia) |
| **E3 — Schema-derived fixture** | Fixture authored from the format's documented/source schema | **All of P1c today** |
| **E4 — Design only** | Code + unit tests of pure functions; no artefact of this format ever parsed | — |

Rule: a capability may be called "supported" only at **E2 or better**. E3 is "implemented, unverified". E4 is
not implemented.

Under this rule the honest status is:

| Format | Grade | Evidence |
|---|---|---|
| FTB (remote API) | **E1** | 92 packs, 83,177 files |
| FTB (install) | **E2** | 3 real packs installed, verified boot, atomic publish |
| Modrinth | **E2** | 12-pack matrix (doc 13), real boots |
| CurseForge | **E2** | 12-pack matrix + route A/B parity |
| **packwiz** | **E3** | my fixture only |
| **Prism** | **E3** | my fixture only |
| **ATLauncher** | **E3** | my fixture only |
| plain server zip | **E3** | my fixture only |

## 5. The minimum change that would make P1c E2 — **and what the feasibility check actually found**

I checked feasibility rather than assuming, and the check changed the plan twice.

### First probe: naive URL guesses — all 404
Blind attempts at GitHub paths for packwiz packs failed. That is the same "assume a location" mistake, so I
stopped guessing and searched properly.

### Second probe: GitHub code search — 2,576 real packwiz packs exist
`filename:pack.toml "packwiz:1.1.0"` → **2,576** files across 2,576 packs (Fabulously Optimized, GregTech
Odyssey, Create Astral, Cabricality, GT:Modern, Project-CBT, …). These are **real, public, fetchable** — the
same situation as the FTB API. So packwiz *can* reach E1/E2 and my earlier "no real archives available"
assumption was wrong.

### Third probe: run my actual parser over six of those real pack files
This is a genuine test of my code against input I did not author:

| Repository | file | pack-format | MC | loader resolved |
|---|---|---|---|---|
| GregTech-Odyssey/GregTech-Odyssey | `pack.toml` | packwiz:1.1.0 | 1.20.1 | forge 47.4.20 |
| Laskyyy/Create-Astral | `pack.toml` | packwiz:1.1.0 | 1.18.2 | fabric 0.18.4 |
| DM-Earth/Cabricality | `pack.toml` | packwiz:1.1.0 | 1.20.2 | **quilt 0.21.0-beta.5** |
| GregTechCEu/GregTech-Modern-Community-Pack | `pack.toml` | packwiz:1.1.0 | 1.20.1 | forge 47.4.10 |
| Ministry-of-CBT/Project-CBT | `pack.toml` | packwiz:1.1.0 | 1.12.2 | forge 14.23.5.2860 |
| Jasons-impart/Create-Delight-Remake | **`modpack.toml`** | packwiz:1.1.0 | 1.20.1 | forge 47.4.16 |

**Result: 6/6 parsed correctly** by my hand-written TOML subset and loader resolver — the first evidence in
this document that anything in P1c is right, and it comes from input I did not write.

**And it exposed something no fixture of mine did:** the last one stores the pack as **`modpack.toml`**, not
`pack.toml`. My adapter only looks for `pack.toml`, so that real pack would be **invisible** to it. That is a
genuine defect found by real input, exactly as predicted — my fixture could never have found it because I
wrote the fixture to contain `pack.toml`.

Also measured: **Quilt packs are common in the wild** (Cabricality), and this app rejects Quilt for new
installs by policy (ADR-0005). So a real share of the packwiz population will resolve to "unsupported by
policy" — a product decision, not an adapter bug, but it must be counted rather than discovered later.

### Per-format reachability, corrected

| Format | E2 reachable? | How |
|---|---|---|
| **packwiz** | **yes, and to E1** | 2,576 real packs on GitHub; fetch `pack.toml`/`index.toml`/`*.pw.toml` over HTTP |
| **plain server zip** | **yes** | the 4 real CurseForge server zips already cached in `.app-data/cache/cfpack/` |
| Prism | **no, without a real instance** | `mmc-pack.json` is written by the launcher, not shipped by packs; caps at E3 |
| ATLauncher | **no, without a real instance** | `instance.json` is client-written; caps at E3 |

## 6. Second finding: P1c shipped a design flaw that only real input reveals

While inspecting (not fixing), one thing is already visible without real archives:

`packwiz`, `prism`, `atlauncher` and `serverzip` all return **`files: []`** and rely entirely on an
**override layer** that extracts the archive. But the archive I hand `installRecipe` is the *pack archive*, and
for packwiz the mods are **not in the archive** — they are downloaded from `[download].url`. My implementation
does produce those files. For Prism/ATL, however, there is genuinely nothing downloadable, so the recipe
depends on the archive containing a complete `.minecraft` tree — which is true for a `MultiMC` instance export
and **false** for a Prism `.mrpack` export. This is a design assumption that no fixture of mine tests, because
I wrote the fixture to contain exactly what the design expects.

This is precisely the class of defect the operator is telling me to find *before* coding further.

## 7. Proposed plan (for agreement, not started)

**Phase A — evidence audit (no new features).**
1. Downgrade the P1c claim in code/docs to **E3 "implemented, unverified"** — a one-line honesty change, not a
   feature.
2. Fetch 3–5 **real** packwiz packs over HTTP; materialise and run the adapter. Record evidence.
3. Run the `plain.serverzip` adapter against the **real CF server zips already cached**. Record evidence.
4. For Prism/ATL: write down that E2 is unreachable without a real launcher-produced instance, and ask whether
   to (a) keep them E3-labelled, (b) obtain a real instance, or (c) drop them until one exists.

**Phase B — fix only what Phase A proves broken.** No speculative edits. Each fix cites the evidence file that
exposed it.

**Phase C — wire into the pipeline** only for formats at E2, and only after A and B.

**Standing rules going forward**
- Any "verified" claim must name its grade and its evidence file, or it is not written.
- No fixture authored by me may be the sole evidence for a format claim.
- Analysis document precedes fix for anything touching format semantics.

## 8. What I am NOT doing in this document

- Not editing the P1c adapters.
- Not committing the P1c code (it stays uncommitted until graded).
- Not claiming any of the above is "fixed".

The P1c code remains in the working tree, uncommitted, plainly labelled: **implemented, unverified (E2 not
met)**.
