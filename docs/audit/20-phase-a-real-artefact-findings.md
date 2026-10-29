# Phase A results: real artefacts vs the design I had written

- Date: 2026-10-29
- Executes the plan in [19](19-stop-and-analyse-evidence-standard.md) §7 Phase A: run the adapters against
  artefacts **I did not author**, record every deviation, fix nothing gratuitously.
- Harness: `scripts/audit-adapters-real.mjs` → `docs/evidence/adapters/real-artefact-audit.json`
- Result: **6 deviations found, 3 of them architectural.** The audit was worth more than the previous 328
  passing tests.

---

## 0. What was actually run

| Evidence source | Real? | Count |
|---|---|---|
| A1 real CurseForge server packs on disk (`.app-data/cache/cfpack`) | yes, fetched by the app | 4 |
| A2 real packwiz packs over HTTP (GitHub code-search corpus of 2,576) | yes, published metadata | 8 |
| A3 real `.mrpack` files on disk | yes | 2 |

Grade this evidence honestly: **A1 and A3 are E2-grade inputs** (real artefacts of the format). **A2 is a
hybrid**: the metadata is genuinely real and fetched over the network, but I still containerise it into a zip
myself — so it is stronger than E3 (the content is not mine) but weaker than E2 (the *delivery shape* is
mine). I label it **E2−** and say so wherever it is used.

## 1. Result table

| Artefact | Adapter claimed | Resolved | Verdict |
|---|---|---|---|
| cf `392141-server-6290699.zip` | plain.serverzip | forge 47.4.0 / MC 1.20.1 | OK |
| cf `466901-server-9296268.zip` | **(none)** | — | **FAIL** |
| cf `829758-server-7243901.zip` | plain.serverzip | — | **FAIL** (no version evidence) |
| cf `936875-server-8853081.zip` | plain.serverzip | forge 47.4.23 / MC 1.20.1 | OK |
| `COBBLEVERSE 1.7.42.mrpack` | **(none)** | — | **FAIL** |
| `Prominence II … .mrpack` | **(none)** | — | **FAIL** |
| packwiz GregTech-Odyssey | packwiz | forge 47.4.20 / 1.20.1, 3 metafiles | OK |
| packwiz Create-Astral | — | — | **FAIL** (index.toml genuinely empty) |
| packwiz Cabricality | packwiz | **quilt** 0.21.0-beta.5 / 1.20.2, 6 metafiles | OK (loader later rejected by policy) |
| packwiz GT:Modern | — | — | **FAIL** |
| packwiz Project-CBT | — | — | **FAIL** |
| packwiz Create-Delight-Remake | — | — | **FAIL** (index.toml 404) |
| packwiz Fabulously Optimized | **(none)** | — | **FAIL** |
| packwiz Create-Prepare-to-Dye | packwiz | forge 43.4.4 / 1.19.2, 6 metafiles | OK |

**Totals: real archives 2/6 resolved, real packwiz 3/8 resolved.** Before this audit the unit suite reported
328/328 passing.

---

## 2. Deviations, ranked by severity

### D1 — ARCHITECTURAL: the adapter layer has no Modrinth adapter

`ADAPTERS = [packwiz, prism, atlauncher, ftb, serverzip]` — **five adapters, and `modrinth` is not among
them.** Both real `.mrpack` files are claimed by *no* adapter.

Why this is worse than "a missing feature": Modrinth is the format this app already installs correctly
(12-pack matrix, real verified boots). The adapter layer was introduced to *generalise* installation, and in
doing so it did not model the one format that already works. When the pipeline is later switched to route
archives through the registry, `.mrpack` input would stop working — a regression introduced by the
generalisation itself.

Root cause: I built adapters for the formats that *didn't* work, and assumed the working ones needed no
adapter. That inverts the requirement: an adapter layer is a **complete** mapping of formats, and "already
handled elsewhere" is a reason to write a thin adapter, not to omit one.

### D2 — ARCHITECTURAL: packwiz is an HTTP-transport format, not a zip format

Measured: `GregTech-Modern-Community-Pack`'s `index.toml` references **86 `*.pw.toml` metafiles**, and every
one sampled (5/5) is individually fetchable over HTTP as its own resource. That is how `packwiz-installer`
works: it reads `pack.toml`, then `index.toml`, then each metafile, **over HTTP**, never from an archive.

My adapter's model is "read `pack.toml` and every metafile out of a zip". Consequences, both observed in the
audit:

- **GT:Modern and Project-CBT both failed** with "yielded no downloadable metafiles" — because my harness only
  put 6 fetched metafiles in the zip while `index.toml` lists 86 and 126. The adapter correctly reported that
  its input was incomplete; the *model* is what is wrong. A real packwiz pack has 86–126 metafiles and there
  is no zip containing them.
- My design only accidentally works when someone happens to zip the whole pack.

Correct model: an archive path is a *bonus* for packwiz (some packs are distributed as zips), but the primary
adapter input must be an HTTP base URL, fetching `pack.toml` → `index.toml` → `*.pw.toml` on demand. That is a
different input kind (`providerApi`/URL), not `archive`.

### D3 — CORRECTNESS: `modpack.toml` is a real pack filename and is invisible

`Jasons-impart/Create-Delight-Remake` stores its pack as **`modpack.toml`**, not `pack.toml`. My detector
requires `pack.toml`, so this real pack cannot be seen. Also `Fabulously-Optimized/fabulously-optimized`
stores per-version packs at `Packwiz/1.21/pack.toml` — i.e. **the pack file need not be at the archive root**.

This was predicted in doc 19 as the exact class of defect a fixture cannot find, and the audit found it.

### D4 — CORRECTNESS: `plain.serverzip` cannot read the CF server packs it was written for

- `466901-server-9296268.zip` (1 GB) — **no adapter claimed it at all** (it is the 2-entry wrapper archive
  whose inner zip holds the real tree; the CurseForge inspector handles that unwrap, the adapter layer does
  not).
- `829758-server-7243901.zip` — claimed, then failed with "does not state its Minecraft version".

Meanwhile the app's **existing CurseForge inspector installs both of these successfully** in the 12-pack
matrix. So the adapter duplicates a capability that already works, worse: it lacks the nested-zip unwrap and
the metadata inference the existing code already has. That is duplicated-and-degraded logic, the worst
outcome of "add a new layer beside the old one".

### D5 — HARNESS defect (not product): my ZIP writer produced corrupt archives

First audit run: every packwiz case failed with `unsupported syntax: PK…`, because `readZipEntry` returned the
*first* entry's bytes for any requested name. My writer set the central-directory **local header offset field
to 0** for every entry. Fixed in `scripts/lib/zip-writer.mjs`.

Recorded deliberately: an audit harness that lies is worse than no audit, and this one lied in the direction
of "the product is broken" for one run. It is now verified by round-tripping distinct sentinel contents.

### D6 — POLICY mismatch surfaced as a data point, not a bug

Cabricality resolves to **Quilt**, which `assertSupportedNewInstallLoader` rejects (ADR-0005). Real packwiz
packs are Quilt a non-trivial fraction of the time. Not an adapter defect — but it means "packwiz supported"
must be qualified as "Forge/Fabric packwiz packs", and the count must be visible rather than discovered per
pack.

---

## 3. What this says about the previous phase (the honest part)

Doc 19 predicted: *"my fixture could never find defects because I wrote it to contain exactly what the design
expects"*. The audit confirms that, concretely:

| Predicted | Found |
|---|---|
| Fixtures cannot detect a misread file name | **D3** (`modpack.toml`), plus pack-in-subdirectory |
| Fixtures cannot detect a wrong input model | **D2** (zip vs HTTP) — the biggest deviation |
| Fixtures cannot detect a missing format | **D1** (`modrinth` absent) |
| Fixtures cannot detect overlap with existing working code | **D4** (CF server packs) |

**328 passing tests coexisted with 6 deviations, 3 architectural.** The tests were not wrong; they were
measuring the wrong thing — internal consistency instead of external correctness.

---

## 4. What I am NOT doing here

- No adapter is being rewritten in this document. D1–D4 each need a design decision (below), and patching them
  immediately is the behaviour that produced 7 bugs earlier.
- The P1c code stays uncommitted.
- No claim of any fix.

## 5. Decisions this audit forces (for the re-analysis that follows)

1. **Modrinth adapter**: must exist, and it should *wrap the existing working Modrinth path* rather than
   re-implement it — otherwise the generalisation regresses the one thing that works.
2. **packwiz input kind**: must be `providerApi`/URL-first (fetch metadata over HTTP), with archive support as
   a secondary path. This changes the adapter contract, so it is a design change, not an edit.
3. **`plain.serverzip`**: should delegate to the existing CurseForge inspector (which already handles wrapper
   archives, nested zips and metadata inference) instead of reimplementing it worse.
4. **Pack file discovery**: `pack.toml` or `modpack.toml`, at root or in a subdirectory — with the subdirectory
   recorded because it defines where `index.toml` and metafiles resolve from.
5. **Loader policy**: Quilt must be reported as an explicit policy rejection with a count, not a silent
   failure.

These five, plus the evidence-grade rule from doc 19, are the inputs to the re-analysis.
