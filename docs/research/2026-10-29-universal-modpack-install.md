# Universal modpack → server: online research and architecture

- Date: 2026-10-29
- Trigger: the app installs the 12 reference packs, but those fixes were derived from *those packs*. This
  research asks the general question instead: **what does it take for an installer to accept ANY modpack?**
- Method: six parallel online investigations (itzg stack source+docs, ServerPackCreator source,
  mrpack-install/packwiz/Prism/ATLauncher/HMCL, pack-format schemas, failure taxonomy from real issue
  reports, and an open-source tool inventory), plus primary-source reads of the Modrinth `.mrpack` spec,
  the Modrinth API, and the itzg `mc-image-helper` CLI reference. Every claim below carries a URL.
- Status: research + design. Only §7 "already true / real gaps" makes claims about the current code.

---

## 1. Verdict

**No tool in the wild installs an arbitrary modpack without a per-format adapter and a boot test.**
The mature answer is three independent layers, and the app currently has roughly one and a half of them:

| Layer | What it is | Who has it |
|---|---|---|
| **A. Format adapters** | Detect a pack's *format* from archive contents, not its extension, and convert it to one canonical recipe | ServerPackCreator detects 6 formats by manifest filename in a fixed order ([ModpackManifestParser.kt](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-api/src/main/kotlin/de/griefed/serverpackcreator/api/config/ModpackManifestParser.kt)); HMCL chains 7 ([ModpackHelper.java](https://github.com/HMCL-dev/HMCL/blob/285e361a/HMCL/src/main/java/org/jackhuang/hmcl/game/ModpackHelper.java)); ATLauncher's importer covers 5 ([InstanceLauncher.java](https://github.com/ATLauncher/ATLauncher/blob/master/src/main/java/com/atlauncher/data/InstanceLauncher.java)) |
| **B. Side resolution** | Decide per file what a dedicated server needs, from declared metadata + jar self-declaration + curated data | itzg (`exclude/include` JSON schema, [mc-image-helper README](https://github.com/itzg/mc-image-helper#excludeinclude-file-schema)); SPC `clientside` scanner ([ForgeTomlScanner.kt](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-api/src/main/kotlin/de/griefed/serverpackcreator/api/modscanning/ForgeTomlScanner.kt)) |
| **C. Boot as the decider** | Only a real start settles the cases where metadata lies | SPC: *"question 1 lies: a mod can declare server/both and still crash a server, because the author implemented their clientside code wrong"* ([clientside README](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-clientside/README.md)); itzg verifies by simply running |

The app has B and C (ported from the reference spike, verified 565/565 L4 verdict parity) but **only two
adapters (Modrinth, CurseForge) and detection by *source kind* chosen in the UI, not by archive contents**.
That is the actual generality gap — not any individual pack.

**The single most important finding:** every mature tool treats "metadata is wrong" as the *premise*,
not an edge case. ServerPackCreator's policy function literally accepts a `declared` argument it never
reads ([Verdict.kt](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-clientside/src/main/kotlin/de/griefed/serverpackcreator/clientside/verdict/Verdict.kt)).
An installer built on "trust the manifest and hope" cannot be general; one built on "adapt the format,
then let the console decide" can.

**Second most important finding — it corrects a claim in our own audit.** itzg does not merely *prefer*
the client manifest over an author's server pack; it **never uses the server pack at all**:
`resolveModpackFile` filters `!file.isServerPack()`, and although `serverPackFileId` is parsed into the
model it is referenced **nowhere else in the repository**
([CurseForgeApiClient.java](https://github.com/itzg/mc-image-helper/blob/master/src/main/java/me/itzg/helpers/curseforge/CurseForgeApiClient.java),
[CurseForgeFile.java](https://github.com/itzg/mc-image-helper/blob/master/src/main/java/me/itzg/helpers/curseforge/model/CurseForgeFile.java)).
Its docs say the same from the user's side: do **not** select a server file, because *"they lack the
required manifest and defeat the ability to consistently automate startup"*
([AUTO_CURSEFORGE docs](https://docker-minecraft-server.readthedocs.io/en/latest/types-and-platforms/mod-platforms/auto-curseforge/)).
This is independent confirmation of fix-11 in [14-fix-provenance.md](../audit/14-fix-provenance.md), and it
is *stronger* than the reference folder's "prefer" wording: the two most battle-tested implementations both
refuse the server pack as an install source.

Consequence for this app: our key-mode CurseForge path takes `serverPackFileId` **first** and only falls
back to the manifest (`curseforge.ts`), i.e. the exact opposite of both references. Several of the
CurseForge edge cases we fixed this week (nested-ZIP unwrap, ServerPackCreator-manifest guard, Forge
promotions lookup) exist *because* we install from a shape that carries no machine-readable metadata.

---

## 2. Format catalogue (what an adapter layer must accept)

Detection must be by **content signature in a fixed priority order**, never by file extension. `manifest.json`
and `instance.json` are each claimed by multiple formats, so keys must be validated.

| Priority | Format | Root signature | MC version | Loader + version | Side data | Third-party legal |
|---|---|---|---|---|---|---|
| 1 | MCBBS | `mcbbs.packmeta` | `addons[] id=game` | `addons[] patch` | launchAdvice | unsure — regional |
| 2 | CurseForge client | `manifest.json` + `manifestType=="minecraftModpack"` + `manifestVersion==1` | `minecraft.version` | `minecraft.modLoaders[].id` = `"forge-47.2.0"` | **none** (only `required`) | API key required; CDN needs key since 2026-07-16 |
| 3 | Modrinth `.mrpack` | `modrinth.index.json` + `formatVersion==1` + `game=="minecraft"` | `dependencies.minecraft` | `dependencies.{forge,neoforge,fabric-loader,quilt-loader}` | `env.{client,server}` ∈ required/optional/unsupported | fully open (CDN URLs in manifest) |
| 4 | HMCL server | `server-manifest.json` | `addons id=game` | `addons patch` | server-only by definition | open |
| 5 | ATLauncher | `instance.json` that ALSO has `id`/`libraries`/`mainClass` | top-level `id` | `launcher.loaderVersion{type,version}` | none (`disabled`/`optional` only) | direct URLs; CF-sourced inherit CF rules |
| 6 | Prism/MultiMC | `mmc-pack.json` (`formatVersion:1` + `components[]`) | `net.minecraft` component | `net.minecraftforge`/`net.neoforged`/`org.quiltmc.quilt-loader` | none | n/a (no server export exists) |
| 7 | packwiz | `pack.toml` (`pack-format="packwiz:1.x"`) + `index.toml` | `[versions].minecraft` | `[versions].{fabric,forge,quilt}` | **only in each `*.pw.toml`**: `side="both\|client\|server"` | open |
| 8 | FTB App | `instance.json` with `uuid,id,versionId,mcVersion,modLoader` + 179-byte `version.json` | `mcVersion` | `modLoader` | `clientonly`/`serveronly` in remote manifest | **`api.feed-the-beast.com` / `api.modpacks.ch` public, unauthenticated — verified live: exact `targets`, per-file sides, SHA-1+size, real download OK** |
| 9 | GDLauncher | `gdlpack.json` | `dependencies.minecraft` | `dependencies.modloaders[]` | `optional` | hash-only resolution |
| 10 | Technic | `bin/modpack.jar` + `mods/` | `bin` jar manifest / build API | renamed loader jar | none | Solder read API public |
| 11 | CF author server pack | **no manifest**: `mods/`+`config/`+(`user_jvm_args.txt`\|`run.sh`\|`startserver.sh`) or `*-installer.jar` | installer jar name / `libraries/` maven path | same | implicit (already filtered) | redistribution grey area |
| 12 | SPC output | `manifest.json` with `files[]`+`minecraftVersion`+`modloader`+`serverPackCreatorVersion` | `minecraftVersion` | `modloader`/`modloaderVersion` | none | n/a |
| 13 | Bare zip | `mods/` only | `version.json`/jar manifest/dir name | jar filenames + `libraries/` | none | n/a |

Sources: [Modrinth mrpack spec](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack) ·
[CurseForge manifest (de-facto)](https://gdlauncher.com/docs/modpack-manifest-format) ·
[GDLauncher spec](https://gdlauncher.com/docs/modpack-manifest-format) ·
[packwiz pack.toml](https://packwiz.infra.link/reference/pack-format/pack-toml/) ·
[packwiz mod.toml](https://packwiz.infra.link/reference/pack-format/mod-toml/) ·
[Prism PackProfile.cpp](https://github.com/PrismLauncher/PrismLauncher/blob/d2fa7cf7/launcher/minecraft/PackProfile.cpp) ·
[ATLauncher InstanceLauncher.java](https://github.com/ATLauncher/ATLauncher/blob/master/src/main/java/com/atlauncher/data/InstanceLauncher.java) ·
[FTB App Instance.java](https://github.com/FTBTeam/FTB-App/blob/main/subprocess/src/main/java/dev/ftb/app/pack/Instance.java) ·
[Solder builds API](https://docs.solder.io/api/read/builds/) ·
[HMCL serverpack docs](https://docs.hmcl.net/modpack/serverpack.html) ·
[SPC manifest API](https://serverpackcreator.de/api/latest/-server-pack-creator/de.griefed.serverpackcreator.api.serverpack/-server-pack-manifest/index.html)

**Hard external constraints (not solvable by code):**
- CurseForge: `x-api-key` required and approval-gated; and since **2026-07-16** even `edge.forgecdn.net`
  direct downloads need the key ([CurseForge blog](https://blog.curseforge.com/introducing-api-key-authentication-for-curseforge-file-downloads/)). Verified independently: an unauthenticated HEAD to that CDN returns **403**.
- CurseForge 3rd-party terms forbid caching API data and building competing products
  ([terms](https://support.curseforge.com/en/support/solutions/articles/9000207405-curse-forge-3rd-party-api-terms-and-conditions)).
- Prism/MultiMC has **no** server export — it is an open feature request
  ([#5475](https://github.com/PrismLauncher/PrismLauncher/issues/5475)); exporting a Prism instance means
  reading `mmc-pack.json` ourselves.
- FTB App instances need the public FTB API; **SPC has no FTB reader at all** — an FTB pack degrades to
  "three empty fields filled in by hand" there.

---

## 3. Side resolution: what the mature implementations actually do

This is where generality is won or lost, and where several of our current rules are **wrong by the
standards of the tools that run at scale**.

### 3.1 Forge `mods.toml` — our rule disagrees with SPC
- **Ours** (`core.ts:1123-1124`): a jar is client-only iff *every* `side=` occurrence in the whole file is
  `CLIENT`.
- **SPC** ([ForgeTomlScanner.kt](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-api/src/main/kotlin/de/griefed/serverpackcreator/api/modscanning/ForgeTomlScanner.kt)):
  the `side` **on the platform dependency** (a dependency whose `modId` matches `^(forge|neoforge|minecraft)$`)
  is the mod's own sideness. No platform entry / no `[[dependencies]]` / any exception ⇒ **SERVER**.
- Why it matters: `[[dependencies]]` blocks for *other* mods also carry `side=`, so "every side is CLIENT"
  is a different predicate from "the mod declares itself client on the platform". Ours can both miss
  client mods (a real client mod with an unrelated `BOTH` dependency line) and mis-disable server mods.

### 3.2 Fabric/Quilt — ours matches, and SPC adds a case we should not miss
Both use `environment == "client"` (case-insensitive) ⇒ CLIENT, anything else ⇒ SERVER
([FabricFamilyScanner.kt](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-api/src/main/kotlin/de/griefed/serverpackcreator/api/modscanning/FabricFamilyScanner.kt)).
Dependencies are the `depends` keys minus `fabricloader|java|minecraft`; `provides` are aliases — **both
matter for the dependency-rescue rule** (§3.4).

### 3.3 Mixin configs — SPC deliberately does *not* parse them
Our `core.ts:1131-1140` reads each `mixins[].config` and greps `environment: client`. SPC does **not**;
mixin failures only exist as a *console* rule `mixin-apply-failure`, ranked *below* the decisive
client-class rule ([boot-rules.default.json](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-clientside/src/main/resources/boot-rules.default.json)).
Keeping ours is defensible (it is extra pre-boot signal), but it must not be able to outrank boot evidence.

### 3.4 The rule we are missing entirely: **dependency rescue**
SPC cannot ship a pack that installs and then dies on load, so before dropping a mod it checks whether a
*kept* mod depends on it, matching the dependency id **and the jar's `provides` aliases** (because
`fabric-api` provides `fabric`) ([ModListCompiler.kt](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-api/src/main/kotlin/de/griefed/serverpackcreator/api/serverpack/ModListCompiler.kt)).
This is exactly the Prominence II failure class we fixed by hand with `unlessPresent` data; the general
mechanism is dynamic and needs no data.

### 3.5 Fail toward keeping the mod
Every ambiguous case in SPC resolves to "keep": unreadable jar, absent descriptor, unparseable version
range, unknown loader ⇒ SERVER/"says nothing"
([JarSelfDeclaration.kt](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-clientside/src/main/kotlin/de/griefed/serverpackcreator/clientside/metadata/JarSelfDeclaration.kt) —
*"Fail toward ACCEPT — this is the whole design."*). Our curated excludes are static data; a static
exclude list that no one maintains is a slow-motion coverage bug. Keep the data, but let boot override it.

### 3.6 Exclusions are themselves a failure source
itzg issue [#4234](https://github.com/itzg/docker-minecraft-server/issues/4234): the default deny list
dropped a **server-required** mod because the pattern `figura` substring-matched `configurable` — silently,
24/24 missing paths, no log line. Therefore: **anchored/regex matching, never bare substring**, and every
exclusion must be logged and attributable to a rule id.

Current state is split, which is exactly the risk: the itzg-sourced lists go through `entryTest`
(`curated.ts:33-38`), which is correctly **anchored** — regex form supported, otherwise
`(^|/)name[-_.]` or `(^|/)name.jar` boundaries. But the **hand override and learned** lookups use bare
`n.includes(norm(o.match))` (`curated.ts:45,48`), so a hand/learned entry can over-match the same way.
Two further gaps: learned entries are version-free mod ids matched against jar *paths*, and neither branch
logs which rule fired.

### 3.8 Curated data is the *only* pack-specific surface, and both projects say so
itzg ships two versioned, user-overridable JSON files — `cf-exclude-include.json` (~200 global slugs +
11 per-pack blocks) and `modrinth-exclude-include.json` (~100 slugs + the `cobbleverse` block + two
force-include regexes) — injected via `--exclude-include-file`, overridable, and disableable
(`MODRINTH_DEFAULT_EXCLUDE_INCLUDES=""`). Everything else is generic
([AUTO_CURSEFORGE docs](https://docker-minecraft-server.readthedocs.io/en/latest/types-and-platforms/mod-platforms/auto-curseforge/),
[Modrinth docs](https://docker-minecraft-server.readthedocs.io/en/latest/types-and-platforms/mod-platforms/modrinth-modpacks/),
[schema](https://github.com/itzg/mc-image-helper#excludeinclude-file-schema)).
Our four data files are byte-identical to the reference's; the missing capability is not the data but the
**override surface** (user-visible, versioned, per-pack editable without a rebuild).

### 3.9 The shared skeleton across every tool (and what nobody does)
Five independent implementations — mrpack-install, packwiz-installer, ATLauncher, HMCL, itzg — collapse to
the **same four stages**, with format only a parser at stage 1:

1. **Manifest → flat file list** of `(dest path, urls, hash)`. mrpack-install `files[]`, packwiz
   `[[files]]` + `*.pw.toml`, HMCL `server-manifest.json files[]`, ATL `Version.mods`, itzg manifest.
2. **One side predicate** over that list — `env.server != "unsupported"` (mrpack-install),
   `downloadSide.hasSide(mod.side)` (packwiz-installer), `Mod::installOnServer` (ATL). *This is the only
   server-specific logic in any of them.*
3. **Layered file tree**: `overrides/` → `server-overrides/` → manifest files, in that precedence.
4. **Loader as an opaque subprocess**: download the official installer and shell out
   (`--installServer` / `--install-server` / `install server`), then read back what it produced.

Two decisive facts follow:

- **`server-overrides/` is honoured by mrpack-install, mc-image-helper and ATLauncher; packwiz writes it;
  Prism and HMCL ignore it.** (An earlier draft of this file claimed only mrpack-install reads it — that was
  wrong; the offline full-repo grep in [2026-10-29-claim-verification.md](2026-10-29-claim-verification.md)
  §7 corrects it. Our app is in the correct majority, not unique.)
- **None of the five validates `env.server` against what the jar actually declares.** They trust the
  declared flag. Our L2 jar self-declaration scan plus the L3 boot loop is *strictly more capable* than any
  tool in this survey on exactly the axis that matters for unseen packs. That is the asset to build on, not
  the adapters alone.

### 3.10 A nuance that keeps us honest about server packs
itzg refuses the server pack, but **ATLauncher does the opposite**: for a CurseForge pack it downloads the
author's server pack and unzips it verbatim — *"downloaded and unzipped without any modifications"* — with
no filtering and no loader install ([Server.java](https://github.com/ATLauncher/ATLauncher/blob/master/src/main/java/com/atlauncher/data/Server.java)).
So "never use the server pack" is a *design preference with a real cost trade-off*, not a rule:
the server pack is fastest and most faithful to the author, but it is opaque, undiffable and — as our own
week showed — often malformed. The defensible policy is: **use the manifest when it exists, fall back to
the server pack only when no manifest is available, and then treat it as an opaque payload that must
still pass the same side-resolution and boot gates.**

### 3.7 Three side vocabularies must be translated, not compared
- mrpack `env.{client,server}`: `required | optional | unsupported`
- Modrinth API `environment`: `client_and_server | client_only | client_only_server_optional | singleplayer_only | server_only | server_only_client_optional | dedicated_server_only | client_or_server | client_or_server_prefers_both | unknown` ([API docs](https://docs.modrinth.com/api/operations/getproject/))
- packwiz `side`: `both | client | server`
- FTB: `clientonly` / `serveronly` booleans
- Forge `mods.toml`: **no sidedness attribute at all** — only the platform-dependency convention
- CurseForge: **structurally UNKNOWN** — there is no server-side field, ever
  ([SPC module.md](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-clientside/module.md))

A canonical tri-state `required | optional | unsupported | unknown` in the recipe, with adapter-specific
readers, is the only way to keep this honest. `unknown` must never silently become `unsupported`.

---

## 4. Loader + Java: the contract, not a command line

**Finding that affects us directly:** Forge/NeoForge generate their own argument files
(`unix_args.txt` / `win_args.txt`) carrying `-DlegacyClassPath` and the module path. Hand-assembling the
line produces exactly the errors in itzg
[#3328](https://github.com/itzg/docker-minecraft-server/issues/3328)
(`Could not find main class cpw.mods.bootstraplauncher.BootstrapLauncher`) and
[#2887](https://github.com/itzg/docker-minecraft-server/issues/2887). The general rule is **exec the
loader-generated args file via `@`-file**, from the correct cwd, with the library tree intact.

Current state (`core.ts:launchCommand`): handles `run.bat` (with `@`-file expansion — good), Fabric/Quilt
launch jars, old Forge runnable jar, `server.jar`. **A modern Forge/NeoForge tree with
`libraries/` + `unix_args.txt` but no `run.bat` has no launch path** and fails at "no launch method found".
That is a genuine generality gap, and it is the *normal* shape of a modern Forge server pack whose author
trimmed the run scripts.

Java selection: SPC reads the recommended major from **Mojang's own server metadata**
(`versionMeta.minecraft.getServer(mc).javaVersion()`) and verifies at runtime with `java -fullversion`,
installing a JDK if it differs ([default_template.sh](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-api/src/main/resources/de/griefed/resources/server_files/default_template.sh)).
Our app already prefers Mojang metadata with an offline table fallback (ADR-0014) — that part matches.
The documented table for reference: 1.12.2→8, 1.17→16, 1.18–1.20.4→17, 1.20.5–1.21.11→21, 26.x→25
([MC wiki](https://minecraft.wiki/w/Tutorial:Update_Java)).

---

## 5. Failure taxonomy → generic mechanism (the part that makes it "any pack")

| # | Failure class | Generic mechanism | Pre-boot? |
|---|---|---|---|
| 1 | No server pack / `serverPackFileId` absent | Build from the authoritative manifest; never treat the author's "server file" as the install source — it has no manifest and defeats automation (itzg docs say this explicitly) | yes |
| 2 | Client-only mod marked required | Per-file side resolution ignoring the pack's `required` flag; curated deny list as override | declared: yes / actual: no |
| 3 | Pack metadata lies | Treat metadata as a hint; boot test for unknowns; publish only crash-proven exclusions | **no** |
| 4 | Over-broad exclusion eats a needed mod | Anchored regex, logged, rule-id-attributed; dependency rescue | yes |
| 5 | Wrong loader / version | Exact loader+version from metadata; derive from artifact metadata, never from filename/type | yes |
| 6 | Loader installed, args wrong | Exec generated args file (`@unix_args.txt`), correct cwd/classpath | partial |
| 7 | Java mismatch | MC→Java from Mojang metadata as a first-class constraint | yes |
| 8 | File unavailable / 403 / DMCA | Availability pre-flight, no silent skip, manual-drop folder | yes |
| 9 | Nested / wrapper / script-only pack | Structural normalization: root detection, nested-zip unwrap | yes |
| 10 | Script-driven pack | Run the vendor installer **once** in a throwaway phase, then own the runtime loop; never let the pack script own it | yes (detect) |
| 11 | World/`server.properties`/`eula.txt` shipped in pack | Separate pack payload from manager-owned state; skip-existing; explicit level selection | yes |
| 12 | Duplicate / colliding jars | Reconcile by declared mod id, not filename | yes |
| 13 | Corrupted download | Hash verify both sides; re-download on mismatch | yes |
| 14 | Datapack/plugin-only, hybrid loaders | Classify pack type up front; refuse silent hybrid substitution | yes |
| 15 | Pack can't run on a server at all | Feasibility gate: every required file must resolve to a server artifact + a loader build | yes |

### Ranked by generality bought
1. **Per-file side resolution** (declared → jar self-declaration → curated → boot escalation). Largest class.
2. **Manifest-as-source-of-truth** with exact IDs and post-download verification that every manifest file landed.
3. **Structural normalization** of the archive (root/nested/wrapper/script-only).
4. **Boot verification** — the only detector for lies; the only legit publisher of an exclusion.
5. **Loader launch contract** (`@`-args file), not a hand-built command.
6. **Environment matrix from the pack** (MC→Java, loader family, memory floor, JVM flags).
7. **Integrity + availability pre-flight**, no silent skips.
8. **State separation** (payload vs manager-owned), explicit precedence.

---

## 6. Proposed architecture: `PackAdapter` + canonical recipe

Replace "two installers with a shared tail" with **one pipeline over adapters**. Each adapter is pure
(reads an archive or provider API, returns a recipe) and can be tested with a fixture.

```ts
type Side = 'required' | 'optional' | 'unsupported' | 'unknown';

interface PackAdapter {
  readonly id: 'modrinth' | 'curseforge' | 'serverpack' | 'packwiz' | 'ftb' | 'atlauncher'
              | 'prism' | 'gdlauncher' | 'technic' | 'mcbbs' | 'hmcl' | 'bare';
  /** Cheap content-signature test, validated by keys — never by extension. */
  detect(files: ArchiveIndex, meta: ProviderMeta): boolean;
  /** Normalize to the canonical recipe; `unknown` sides stay unknown. */
  resolve(input: AdapterInput, io: AdapterIo): Promise<PackRecipe>;
}

interface PackRecipe {
  name: string;
  mc: string;                    // exact, never guessed
  loader: LoaderFamily;          // forge | neoforge | fabric | quilt | vanilla | paper | hybrid
  loaderVersion: string | null;  // null ⇒ resolve from provider promotions/API
  javaMajor: number | null;      // null ⇒ resolve from Mojang metadata
  files: PlannedFile[];          // { path, source: {url|providerId}, hashes, size, side, provenance }
  overrides: OverrideLayer[];    // ordered: overrides → server-overrides (client-overrides never applied)
  launch: 'generated-args' | 'launch-jar' | 'runnable-jar' | 'server-jar' | 'vendor-script';
  state: { managerOwned: string[]; worldLevel?: string };  // payload vs manager-owned split
  warnings: RuleAttributed[];    // every exclusion/warning carries a rule id
}
```

Pipeline (one path, all adapters):

1. **Acquire** — file/URL/upload; hard-link into a run root.
2. **Normalize** — list entries once; unwrap single nested zip; strip a single wrapping directory;
   record an `ArchiveIndex`.
3. **Detect** — run adapters in priority order; first *validated* match wins; no match ⇒ explicit
   `unsupported` with the reason and the evidence checked (never "unknown pack").
4. **Resolve** — adapter → recipe; fill gaps through a documented chain: archive metadata → provider API →
   provider promotions (Forge/NeoForge) → Mojang metadata (Java). Each step logged with its source.
5. **Side resolution** — canonical §3 stack, three-valued, rescue-by-dependents, stable logging.
6. **Plan + review** — recipe → user-facing plan; conflicts become explicit choices; unresolved conflicts block.
7. **Staged install** — loader, files (hash-verified), override layers in order, manager-owned state written last.
8. **Verify** — boot to `Done (`; L2 prescan then L3 attribution loop; each exclusion rule-attributed.
9. **Publish/rollback** — atomic swap; write a sidecar able to *diff* next time (hashes, provider IDs, file list).

---

## 7. What is already true, and the real gaps in this app

**Already there (keep):** L2/L3 stack with curated data (byte-identical to the reference, 565/565 verdict
parity), CF prune-only vs Modrinth fetch, staged transaction with rollback, verified boot before publish,
hash/size verification, no-Range + 2 req/s CF posture, script non-execution, safeStorage key.

**Real gaps, ranked by how much generality they cost:**

| # | Gap | Evidence |
|---|---|---|
| 1 | **Detection is by UI source kind, not archive content.** No adapter layer; `.mrpack`/CF only. A packwiz/FTB/ATLauncher/Prism/MCBBS/bare pack cannot be opened at all. | `pipeline.ts` `PipelineSourceRequest` has 4 kinds, all provider-specific |
| 2 | **No loader-args launch path.** Modern Forge/NeoForge without `run.bat` ⇒ `no launch method found`. Both mrpack-install (via a pinned ServerStarterJar for Forge 1.17+) and SPC (ServerStarterJar against `unix_args.txt`) solve this; we do not. | `core.ts` `launchCommand` |
| 3 | **Forge side rule differs from SPC** (all-`side=` vs platform-dependency `side`). | `core.ts:1123` vs ForgeTomlScanner.kt |
| 4 | **No dependency rescue.** Excluding a mod can strand a dependent; we compensate with hand data (`unlessPresent`). | ModListCompiler.kt vs `curated.ts` |
| 5 | **Hand/learned exclusion matching is substring-based** ⇒ the `figura`/`configurable` over-exclusion class. (The itzg lists are correctly anchored via `entryTest`; hand+learned are not.) Also no rule id is logged. | `curated.ts:45,48` (`n.includes(...)`) vs `curated.ts:33-38` (`entryTest`) |
| 6 | **Canonical side is missing `unknown`.** CurseForge has no side data; we currently derive it only from a curated list. Note mrpack-install *fatals* on an unrecognised `env.server`, which is the wrong direction — `unknown` must be first-class. | SPC module.md: CF is structurally UNKNOWN |
| 7 | **Learning is not read at install time** (only at server start), so pack A does not improve pack B's *downloads*. Every tool above persists and reads a manifest per run; we persist a sidecar that cannot diff. | `pipeline.ts` resolver calls omit `learnedFile` |
| 8 | **No feasibility gate** (pack that cannot run on a server never fails fast with a reason). | taxonomy row 15 |
| 9 | **No persisted file manifest for diff-based reinstall/cleanup.** Every surveyed tool keeps one (`packstate.json`, `.curseforge-manifest.json`, ATL `server.json`, HMCL `server-manifest.json`); ours records counts, and CF `files: []`. This is the prerequisite for update and for safe cleanup. | `pipeline.ts` sidecar writer |
| 10 | **Manual-required is prose, not a machine-readable report.** itzg writes `MODS_NEED_DOWNLOAD.txt` and supports a `/downloads` drop folder. | `curseforge.ts:616` → warning text only, no drop folder |

---

## 8. Implementation plan (phased, each phase independently verifiable)

**P1 — Adapter layer + canonical recipe (the generality core).**
`electron/services/adapters/` with `detect()` + `resolve()` per format; `ArchiveIndex` from one zip listing;
priority-ordered detection with key validation. First adapters: `modrinth`, `curseforge`, `serverpack`,
`bare` (covers everything the app does today, via the new path, so no regression), then `packwiz`,
`prism`, `atlauncher`, `ftb`, `gdlauncher`, `technic`, `mcbbs`, `hmcl`.
*Proof:* fixture corpus (§9) — every fixture detected by id, no fixture mis-detected.

**P2 — Side resolution rewrite** (canonical tri-state + SPC platform-dependency rule + rescue +
anchored matching + rule ids in the report).
*Proof:* unit tests per rule; the 12-pack matrix still 12/12; the `figura`/`configurable` case reconstructs
correctly; a synthetic "client mod marked required" fixture is excluded pre-boot.

**P3 — Loader launch contract.** `launchCommand` gains `unix_args.txt`/`win_args.txt`/`args.txt` support and
a `-DlegacyClassPath` sanity check; refuses to hand-build Forge module-path args. Reference behaviour to
copy rather than invent: mrpack-install ships a pinned ServerStarterJar for Forge 1.17–1.20.2 whose only
`run.sh` is an argfile, and SPC does the same for Forge ≥1.17.
*Proof:* fixture tree with `libraries/`+`unix_args.txt` and no `run.bat` boots; existing packs unchanged.

**P4 — Feasibility gate + provider capability matrix.** Before install: every required file resolves to a
server-installable artifact, loader build exists for that MC, Java major resolvable. Otherwise fail with a
reason (`LOCKED` / `NO_SERVER_ARTIFACT` / `UNVERIFIABLE`) instead of discovering it at boot.
*Proof:* a pure-client fixture and a distribution-locked fixture fail fast with the right code.

**P5 — Persisted file manifest + diff-based reinstall.** Write the exact `(path, hash, provenance)` set;
next run diff it, skip when complete, delete only files the previous run owned, never touch world/manager
state. Prerequisite for the update flow the reference promised.
*Proof:* install twice → second run is a no-op; remove one file → only it is restored; hand-added file is
preserved; world dir untouched.

**P6 — Learning loop closed + machine-readable manual report.** Install-time resolvers read the learned
file; learn only post-success; write `MODS_NEED_DOWNLOAD.txt` and honour a drop folder.
*Proof:* pack A's learned disable changes pack B's preview decisions; a fixture with one unavailable file
produces the report and succeeds once the file is dropped in.

**P7 — Corpus harness (replaces per-pack acceptance).** `--adaptertest` runs every fixture through
detect→resolve→install-plan and asserts the recipe. Live matrix stays as a sanity net, not as the proof.

---

## 9. How to prove generality instead of asserting it

Per-pack acceptance (the 12-pack matrix) proves *those* packs. Generality needs a corpus:

| Corpus tier | Contents | Proves |
|---|---|---|
| **T0 synthetic fixtures** (committed, offline) | one per format: mrpack, CF client, CF server pack, nested wrapper, SPC output, packwiz, prism, atlauncher, FTB instance, gdlauncher, technic, mcbbs, bare zip, script-only, pure-client (must fail), locked-file (must fail) | detection + resolution correctness, no network |
| **T1 mutation fixtures** | each T0 reshaped: single wrapping dir, double zip, missing manifest key, wrong `manifestVersion`, jar with contradicting descriptors, case-colliding names | structural normalization + fail-closed |
| **T2 live provider sweep** | the 12 reference packs + arbitrary Modrinth slugs picked by *category*, not by name | real network/metadata behaviour |
| **T3 boot corpus** | a small set of real packs spanning loaders/eras (Forge 1.12.2 / 1.16.5 / 1.20.1, NeoForge 1.21.1, Fabric 1.20.1, Quilt) | boot/verify + Java matrix |

Acceptance for "any pack": **T0+T1 100%**, T2 ≥ the current 12/12, T3 all pass or fail with a classified
reason. A pack that fails must produce a *rule-attributed* reason — that is what distinguishes "we do not
support this shape yet" from "we patched this one pack".

---

## 10. Honest limits (nothing here makes every pack installable)

1. **Distribution-locked CurseForge files** (`allowModDistribution=false`) have no URL at all → cannot be
   fetched, scanned, or booted. SPC returns `LOCKED`; we must too. The only path is a user-supplied drop folder.
2. **CurseForge CDN now requires an API key** (2026-07-16) and the terms forbid self-registration for end
   users → CurseForge installs fundamentally depend on a user key. Verified: an unauthenticated HEAD to
   `edge.forgecdn.net` returns **403**.
3. **Pure client packs and paid/private mods** cannot be installed as servers by anyone.
4. **A pack can lie in ways only boot reveals**, and a boot may take minutes; a bounded retry budget means a
   pathological pack can still fail (`UNVERIFIABLE`), correctly and explicitly.
5. **Mojang assets are never redistributed** — the installer downloads the server jar, it does not ship it.
6. No tool in this survey claims universal success; SPC's own README says *"not a guarantee for working
   server packs… you must still test them."* Our promise should be: **every pack is either installed and
   verified, or rejected with a rule-attributed reason** — never silently wrong.

### Claims from this research — now verified offline against full checkouts
All previously UNVERIFIED items were re-checked by shallow-cloning the eight repositories and grepping the
**complete working trees** (not the rate-limited search API). Full evidence, commit hashes and reproduction
commands: [2026-10-29-claim-verification.md](2026-10-29-claim-verification.md).

**Confirmed absent** (0 hits across scripts, source and docs): `CF_IGNORE_JAVA_VERSION`,
`CF_SKIP_UPGRADE`, `MODPACK_TYPE`, `CF_OVERRIDES_EXCLUDES`, `CF_OVERRIDES_INCLUDES`. itzg therefore has
**no Java gate at all** — wrong Java is a documented symptom class only.

**Confirmed dead:** `CF_PARALLEL_DOWNLOADS` appears **only in docs** (2 hits) and is assigned in
`start-deployAutoCF:11` but never forwarded to the helper's `args` array. The live knob is
`--max-concurrent-downloads` / `CF_MAX_CONCURRENT_DOWNLOADS`, default **10**
(`InstallCurseForgeCommand.java:197`, `CurseForgeInstaller.java:589`); Modrinth's is
`MODRINTH_MAX_CONCURRENT_DOWNLOADS`, default 10. Copy the live one, not the documented one.

**Confirmed:** `preset` is not a packwiz key (0 hits in the whole repo; the real index-entry schema is
`file, hash, hash-format, alias, metafile, preserve`, and `side` lives on the mod metafile). SPC has no FTB
reader (0 hits for `FTB`; `ModpackSource` = `ZIP | MODRINTH | CURSEFORGE | DIRECTORY`). Prism has no server
export (three export actions, 0 hits for `ServerPack`; its mrpack exporter only *marks*
`env.server="unsupported"` for client mods). itzg never uses the server pack — the code comment says why:
*"even though we're preparing a server, we need client modpack to get deterministic manifest layout"*
(`CurseForgeApiClient.java:200-215`). ATLauncher does use it (`isServerPack && isAvailable`,
`InstanceInstallerDialog.java:466-485`).

**Also found:** `REMOVE_OLD_MODS` is force-disabled for modpack platforms — `ensureRemoveAllModsOff()` in
`start-utils:749` logs *"interferes with … it is now disabled"* and resets it. And `REMOVE_OLD_MODS_DEPTH`
is documented as 16 in prose but defaults to **1** in `start-setupModpack:10`, while the same doc's own
example uses 1 — an upstream doc bug.

**Still open (0).** Both former open items were closed with harder evidence:
[2026-10-29-claim-verification.md](2026-10-29-claim-verification.md) §12 traces `CF_PARALLEL_DOWNLOADS`
through full git history (it *did* work, 2023-01-12 → 2023-04-23, removed in `d0dcc68`; docs never updated),
and §13 exercises the public FTB API live: no auth, exact `targets` (forge 14.23.5.2846 / minecraft 1.12.2 /
java 8), 1,483 files with `clientonly`/`serveronly` flags, and a real file downloaded with matching size and
SHA-1. **FTB is therefore a first-class adapter candidate and needs no API key at all** — the cheapest live
proof of generality beyond Modrinth/CurseForge.

---

## 11. Sources

Primary specs and source code are linked inline above. The investigation also drew on:
[itzg AUTO_CURSEFORGE docs](https://docker-minecraft-server.readthedocs.io/en/latest/types-and-platforms/mod-platforms/auto-curseforge/) ·
[itzg Modrinth docs](https://docker-minecraft-server.readthedocs.io/en/latest/types-and-platforms/mod-platforms/modrinth-modpacks/) ·
[itzg FTB docs](https://docker-minecraft-server.readthedocs.io/en/latest/types-and-platforms/mod-platforms/ftb/) ·
[itzg Java versions](https://docker-minecraft-server.readthedocs.io/en/latest/versions/java/) ·
[itzg JVM options](https://docker-minecraft-server.readthedocs.io/en/latest/configuration/jvm-options/) ·
[itzg hybrids](https://docker-minecraft-server.readthedocs.io/en/latest/types-and-platforms/server-types/hybrids/) ·
[mc-image-helper README (CLI + exclude/include schema)](https://github.com/itzg/mc-image-helper#excludeinclude-file-schema) ·
[SPC CLI/HELP](https://github.com/Griefed/ServerPackCreator/blob/main/HELP.md) ·
[SPC ModpackZipInspector.kt](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-api/src/main/kotlin/de/griefed/serverpackcreator/api/config/ModpackZipInspector.kt) ·
[SPC GenerationConfig.kt](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-api/src/main/kotlin/de/griefed/serverpackcreator/api/settings/GenerationConfig.kt) ·
[SPC LoaderDescriptors.kt](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-api/src/main/kotlin/de/griefed/serverpackcreator/api/modscanning/LoaderDescriptors.kt) ·
[SPC grinder README](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-grinder/README.md) ·
[mrpack-install](https://github.com/nothub/mrpack-install) ·
[mrpack4server](https://github.com/Patbox/mrpack4server) ·
[packwiz index.toml](https://packwiz.infra.link/reference/pack-format/index-toml/) ·
[FTB modpacks.ch API](https://modpacks.ch/api) ·
[Solder docs](https://docs.solder.io/guides/adding-mods) ·
[Forge Sides](https://docs.minecraftforge.net/en/latest/concepts/sides/) ·
[fabric.mod.json spec](https://wiki.fabricmc.net/documentation:fabric_mod_json_spec) ·
[Modrinth environments](https://modrinth.com/news/article/new-environments/) ·
[CF API intro](https://docs.curseforge.com/rest-api/) ·
[CF key-for-downloads announcement](https://blog.curseforge.com/introducing-api-key-authentication-for-curseforge-file-downloads/)
