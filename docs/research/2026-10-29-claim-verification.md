# Verification of every UNVERIFIED claim (offline, full-repo grep)

- Date: 2026-10-29
- Question: can the claims previously marked UNVERIFIED be settled definitively?
- Answer: **yes — all but two, and one earlier claim was found to be WRONG.**
- Method: shallow-cloned all eight repositories to `H:\TESTMultiAI\verify-repos` and grepped the **complete
  working trees** (not the GitHub search API, which was rate-limited and only checks an index). Grep of a
  full checkout is positive evidence of absence, not a search-index artefact.

## Repositories and exact commits examined

| Repo | Commit |
|---|---|
| itzg/docker-minecraft-server (image scripts + docs) | `5692cf852ed89738dd2f5cfb2837bc763d4d2474` |
| itzg/mc-image-helper | `9f0100db1c5873cc47979e2adf9abe5b21531801` |
| Griefed/ServerPackCreator | `163a6bd4bc27a3d80eca4dca00ce0e1299e0db21` |
| packwiz/packwiz | `170b22d785959dda5876b54b7f16e1b807a57fb6` |
| PrismLauncher/PrismLauncher | `181408813f46367ee8f709194424292bb355bbaf` |
| ATLauncher/ATLauncher | `8e9a71345bf35aee4e927a848930e946de331b30` |
| HMCL-dev/HMCL | `f05647fc82c0d8ba533df62eb5863e280cbd9674` |
| nothub/mrpack-install | `26953790d4ba37c90025a716bea08de0590f1429` |

---

## 1. Phantom environment variables in itzg — CONFIRMED ABSENT

Grepped every file in both itzg repos. Zero occurrences anywhere (scripts, Java, docs, compose, CI):

| Variable | Hits | Verdict |
|---|---|---|
| `CF_IGNORE_JAVA_VERSION` | **0** | does not exist |
| `CF_SKIP_UPGRADE` | **0** | does not exist |
| `MODPACK_TYPE` | **0** | does not exist (the real names are `MODPACK_PLATFORM` / `MOD_PLATFORM` / `TYPE`) |
| `CF_OVERRIDES_EXCLUDES` | **0** | does not exist |
| `CF_OVERRIDES_INCLUDES` | **0** | does not exist |

Corollary confirmed: **itzg has no Java-version gate at all.** "Wrong Java" is a documented symptom class
only (`docs/versions/java.md`), never a checked precondition in the install path.

## 2. `CF_PARALLEL_DOWNLOADS` is dead — CONFIRMED, with proof

Exactly **2 hits, both in documentation**, zero in code or scripts:

- `docs/types-and-platforms/mod-platforms/auto-curseforge.md:349` — "`CF_PARALLEL_DOWNLOADS` (default is 4)"
- `docs/variables.md:677` — the variable table entry

And it *is* assigned in the deploy script, then never used:
- `scripts/start-deployAutoCF:11` — `: "${CF_PARALLEL_DOWNLOADS:=4}"`
- `scripts/start-deployAutoCF:28-63` — the `args` array that is actually handed to
  `mc-image-helper install-curseforge` contains **no concurrency flag** (it forwards `--modpack-page-url`,
  `--file-id`, `--slug`, `--modpack-manifest`, `--filename-matcher`, `--set-level-from`,
  `--overrides-exclusions`, `--ignore-missing-files`, `--api-cache-default-ttl`, `--exclude-mods`,
  `--exclude-all-mods`, `--force-include-mods`, `--exclude-include-file`, `--mod-loader-version`,
  `--downloads-repo`, plus a few booleans — nothing concurrency-related).

The real knob, positively confirmed:
- `mc-image-helper/.../InstallCurseForgeCommand.java:197` —
  `@Option(names = {"--max-concurrent-downloads"}, defaultValue = "${env:CF_MAX_CONCURRENT_DOWNLOADS:-10}")`
- `.../CurseForgeInstaller.java:589` — `maxConcurrentDownloads > 0 ? maxConcurrentDownloads : 10`
- Modrinth equivalent: `.../InstallModrinthModpackCommand.java:141` — `MODRINTH_MAX_CONCURRENT_DOWNLOADS`, default 10

**Verdict: the documented variable is inert; copy `CF_MAX_CONCURRENT_DOWNLOADS` (10), not the docs.**

Bonus finding while verifying: `REMOVE_OLD_MODS_DEPTH` is documented as 16 in one place
(`docs/index.md:65`, `docs/modpack.md` prose) but the code default is **1**
(`scripts/start-setupModpack:10`), while `index.md:67`'s own example passes `REMOVE_OLD_MODS_DEPTH=1`.
Documented example contradicts the documented default — a genuine doc bug in the upstream project.

## 3. `REMOVE_OLD_MODS` force-disabled for modpack platforms — CONFIRMED

`scripts/start-utils:749`:

```sh
function ensureRemoveAllModsOff() {
  reason=${1?}
  if isTrue "${REMOVE_OLD_MODS:-false}"; then
    logWarning "Using REMOVE_OLD_MODS interferes with $reason -- it is now disabled"
    REMOVE_OLD_MODS=false
  fi
}
```

Called from `start-deployAutoCF:32` (`MODPACK_PLATFORM=AUTO_CURSEFORGE`), `start-deployModrinth:26`
(`MODPACK_PLATFORM=MODRINTH`), `start-deployGTNH:343`, and in `start-setupModpack` when
`MODS`/`PLUGINS`/`MODS_FILE`/`PLUGINS_FILE` are set. Verdict: **confirmed exactly as reported.**

## 4. `preset` is not a packwiz key — CONFIRMED, strongest possible form

Grepped **every file of any extension** in the packwiz checkout (excluding `.git`): **0 hits**.

Ground truth from the actual TOML struct tags:

`core/indexfiles.go` — index file entry:
```go
File       string `toml:"file"`
Hash       string `toml:"hash,omitempty"`
HashFormat string `toml:"hash-format,omitempty"`
Alias      string `toml:"alias,omitempty"`
MetaFile   bool   `toml:"metafile,omitempty"`
Preserve   bool   `toml:"preserve,omitempty"`
```
`core/mod.go` — mod metafile:
```go
Name     string    `toml:"name"`
FileName string    `toml:"filename"`
Side     string    `toml:"side,omitempty"`
Option   *ModOption `toml:"option,omitempty"`
```
`core/index.go`: `HashFormat string \`toml:"hash-format"\``, `Files indexFilesTomlRepresentation \`toml:"files"\``.

**Verdict: `preset` does not exist. The index entry schema is exactly
`file, hash, hash-format, alias, metafile, preserve`; side lives on the mod metafile as
`side, option`, and `preserve` is the field that protects user edits.** This also confirms the earlier
report's claim that `[[files]]` is an `index.toml` key, not a `pack.toml` key.

## 5. SPC has no FTB reader — CONFIRMED

Grepped every file in the ServerPackCreator checkout for `FTB`, `feed-the-beast`, `feedthebeast`:
**0 hits.** `ModpackSource` enum contains only `ZIP | MODRINTH | CURSEFORGE | DIRECTORY`
(`serverpackcreator-api/src/main/kotlin/de/griefed/serverpackcreator/api/config/ModpackSource.kt`).

**Verdict: confirmed.** An FTB pack supplied to SPC degrades to "a directory with three empty fields",
exactly as reported.

## 6. Prism has no server export — CONFIRMED, both halves

The export menu adds exactly three actions (`launcher/ui/MainWindow.cpp:225-227`):
`actionExportInstanceZip`, `actionExportInstanceMrPack`, `actionExportInstanceFlamePack`.
Grepping the whole C++ tree for `ServerPack|ExportServer|server.export` yields **0 hits**.

And the Modrinth exporter is client-oriented (`ModrinthPackExportTask.cpp:283-303`): it writes
`env["client"]` / `env["server"]` as `optional`/`required`, and only for a client-side mod does it set
`env["server"] = "unsupported"` — i.e. it *marks* client mods, it does not produce a server pack.

**Verdict: confirmed.** Prism cannot export a server pack; "Export as Server Pack" remains an open request.

## 7. CORRECTION — "only mrpack-install reads `server-overrides/`" was WRONG

My earlier report claimed only mrpack-install (and this app) reads `server-overrides/`. Full-tree grep
refutes it:

| Repo | `server-overrides` hits | Real behaviour |
|---|---|---|
| mrpack-install | 11 (`overrides.go:20,43-44`) | reads it, deliberately layered after `overrides/` |
| **mc-image-helper** | 1 (`ModrinthPackInstaller.java:128`) | **`extractOverrides("overrides", "server-overrides")` — reads it** |
| **ATLauncher** | 2 (`InstanceInstaller.java:3474-3475`) | **`if (isServer && …resolve("server-overrides"))` → copies it** |
| **packwiz** | 1 (`modrinth/export.go:171`) | **exports** into `server-overrides/` (write side, not read) |
| PrismLauncher | 0 | does not handle it |
| HMCL | 0 | does not handle it |

Corrected statement: **mrpack-install, mc-image-helper and ATLauncher all honour `server-overrides/` on
install; packwiz writes it; Prism and HMCL ignore it.** Our app is in the correct majority, not a unique one.

## 8. itzg never uses the CurseForge server pack — CONFIRMED, with the source comment

`CurseForgeApiClient.java:200-215`:

```java
return files.stream()
    .filter(file ->
        // even though we're preparing a server, we need client modpack to get deterministic manifest layout
        !file.isServerPack() &&
            matcher.matches(file.getFileName())
    )
```

And `serverPackFileId` appears **only** as a model field (`CurseForgeFile.java:35`), never read for
resolution. Verdict: **confirmed**, and the rationale is in the code comment itself — deterministic
manifest layout, exactly as reported.

## 9. ATLauncher does use the server pack verbatim — CONFIRMED

`CurseForgeFile.java:53-54` declares `isServerPack` / `serverPackFileId`;
`CurseForgePackCard.java:129` shows "Create Server" only when a server pack exists;
`InstanceInstallerDialog.java:466-485` collects server-pack file ids and filters
`f.isAvailable && f.isServerPack && f.getGameVersion() != null`.

**Verdict: confirmed.** So the contrast stands: itzg refuses the server pack, ATLauncher prefers it —
a genuine trade-off, which is why my report frames it as policy rather than a rule.

---

## 10. Claims that remain UNVERIFIED (and why)

| Claim | Status | Why it cannot be settled by grep |
|---|---|---|
| Whether `CF_PARALLEL_DOWNLOADS` was *ever* wired to `--max-concurrent-downloads` in an earlier release | **UNVERIFIED** | Would require full git history with tags/branches, not a shallow clone of `master`. Settle with `git log -S` on a full clone if it ever matters. |
| FTB end-to-end support in any tool other than itzg | **UNVERIFIED** | itzg's FTBA path exists (`start-deployFTBA`), but no full real-pack run was observed in this session. |

Everything else previously marked UNVERIFIED is now **settled**.

## 11. Net effect on the research document

Three edits were applied to
[2026-10-29-universal-modpack-install.md](2026-10-29-universal-modpack-install.md):

1. §3.9 — the `server-overrides/` claim was **corrected** (three tools honour it, not one).
2. §10 — the UNVERIFIED list was replaced with confirmed/refuted results plus the two genuinely open items.
3. §11 — this verification file is referenced, with commits so any reader can reproduce the greps.

Reproduce with:

```powershell
cd H:\TESTMultiAI\verify-repos
Select-String -Path (Get-ChildItem itzg-image,mc-image-helper -Recurse -File).FullName -Pattern 'CF_IGNORE_JAVA_VERSION' -SimpleMatch
Select-String -Path (Get-ChildItem packwiz -Recurse -File).FullName -Pattern 'preset' -SimpleMatch
```
