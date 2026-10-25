# Research — Full Version Catalogue (All Installable Provider Builds)

**Accessed:** 2026-10-09
**Scope:** backend-006 — replace stable-only version lists with all valid, installable versions per supported provider (Paper, Fabric, Forge, NeoForge + Vanilla snapshots). Three parallel Scout workers verified the official contracts live; this note consolidates their findings (treated as read, no re-verification).

## 1. Paper (Fill API v3) — every channel is installable

- List builds: `GET https://fill.papermc.io/v3/projects/paper/versions/{mc}/builds` returns a bare JSON **array** of builds. Single build and `.../builds/latest` variants exist. Project catalogue: `GET /v3/projects/paper` → `{"versions": {group: [mc...]}}`.
- Observed `channel` values: `STABLE`, `BETA`, `ALPHA` (live: 1.21.11 has 63 STABLE / 17 BETA / 12 ALPHA of 92 builds). `RECOMMENDED` exists but is currently Velocity-only. No `EXPERIMENTAL` enum value observed; "experimental" in docs is prose.
- **Installability rule: a build is installable iff it exposes complete `downloads["server:default"]` (`url` + `size` + `checksums.sha256`, trusted `fill-data.papermc.io` host) — regardless of `channel`.** Verified live: BETA 66/65/64 and ALPHA 48 of 1.21.11 all carry full server artifacts. `STABLE` is a support/recommendation marker, not a technical gate.
- Error shape: unknown MC version returns HTTP 200 + `{"ok":false,"error":"version_not_found",...}` (object, not array) — must fail closed on non-array.
- Required header: descriptive `User-Agent` with contact URL/email (already sent by current code).
- Current gap: `paper_builds` (`installer/mod.rs:1429`) drops `channel != STABLE`, excluding ~1/3 of installable builds; triple impact on listing, `resolve_paper_versions` whole-version gate, and install-time rejection.

## 2. Fabric (Meta v2) — `stable` is advisory, not a gate

- Catalogue: `GET https://meta.fabricmc.net/v2/versions/loader/{mc}` → array of `{loader:{version, stable, ...}, intermediary, launcherMeta}`. Exact: `GET /v2/versions/loader/{game_version}/{loader_version}` → `{loader, intermediary, launcherMeta}`. Verified live for `stable:false` loader `0.19.4`: full valid metadata, same shape as stable.
- Server launcher route `GET /v2/versions/loader/{mc}/{loader}/{installer}/server/jar` performs **no stable gating** — HTTP 200 verified for both stable:false installer (`1.21/0.16.14/1.0.3`) and stable:false loader (`1.21/0.19.4/1.1.2`).
- Installer list `GET /v2/versions/installer`: only `1.1.2` is `stable:true` today; older installers are valid downloads. Keep pinning latest stable installer as the default.
- **Installability rule: a loader is installable iff the exact endpoint resolves (HTTP 200 + `loader.version` matches) — regardless of `stable`.** Error shapes: unknown loader → HTTP 400 plain text (`no loader version found for ...`); unknown game version → HTTP 200 `[]`.
- Current gap: `resolve_loader_choices` (`:1371`) and `validate_fabric_loader` (`:1732-1737`) require `stable == true`, excluding valid loaders (e.g. `0.19.4` for 1.21). Inconsistent with the modpack exact path (`validate_exact_fabric_loader_metadata`), which correctly ignores `stable`.

## 3. Forge — full catalogue exists on the same official host

- `promotions_slim.json` is a ≤2-entry-per-MC promotions map, **not** a catalogue (e.g. 1.21 has only `latest`; promotions lag — `1.20.4-latest = 49.2.8` while `49.2.9` already published).
- **Official complete catalogue: `https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json`** — map of MC version → full artifact-version list (live: 78 MC keys; 1.12.2 = 355 builds, 1.20.1 = 135, 1.21 = 25). Alternative: `https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml` (flat `<version>{mc}-{build}</version>` list, filter by `{mc}-` prefix).
- **Installability rule: every catalogue entry is installable, promoted or not** (itzg documents `FORGE_VERSION` as "recommended, latest, **or specific version**", e.g. `14.23.5.2854` which is neither promotion). Validate by **exact catalogue membership** — never reassemble parts (ancient MCs have suffixed artifacts like `-mc172`, `-prerelease`).
- Installer URL (unchanged): `https://maven.minecraftforge.net/net/minecraftforge/forge/{artifact}/forge-{artifact}-installer.jar` where `{artifact}` is the exact catalogue string. Invocation `java -jar installer.jar --installServer` (cwd = target); exit 0 success / 1 failure (official `SimpleInstaller.java`).
- Launch shapes unchanged: modern (`run.bat` + `user_jvm_args.txt` + `libraries/.../win_args.txt`); legacy 1.12.2 (universal JAR + `minecraft_server.1.12.2.jar` beside it, per FML `README.txt`).
- Current gap: `resolve_loader_choices` + `resolve_install_artifact` Forge branches only offer/accept the ≤2 promotions; hundreds of valid builds per MC unreachable.

## 4. NeoForge — prefix approach already complete for mapped MCs

- Catalogue: `https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml` (complete `<version>` list incl. betas and `26.x` alphas). Installer URL pattern and `--installServer` invocation match current code.
- Versioning doc (`https://docs.neoforged.net/docs/gettingstarted/versioning/`): old scheme omits leading `1` (`20.2.59` = MC 1.20.2); new scheme uses full MC version (`26.1.0.5-beta` = MC 26.1). Confirmed mappings: `47.x` = 1.20.1, `20.4.x` = 1.20.4, `20.6.x` = 1.20.6, `21.0.x` = MC 1.21.0, `21.1.x` = MC 1.21.1.
- **Current code already lists all builds for its 4 mapped MCs** (prefix filter over complete metadata, betas included). Gaps: (a) MCs absent from the hardcoded `neoforge_prefix` table (in `installer/mod.rs` **and** duplicated in `servers/process.rs` — keep in sync) are unreachable; extend only by documented mapping, never numeric inference. (b) No beta/release distinction surfaced — product decision: label betas, default stable-first.
- NeoForge exit-code semantics are inferred from the shared installer lineage, not NeoForge-documented; keep nonzero-means-failure handling.

## 5. Mojang — snapshots are installable like releases

- Manifest (`https://piston-meta.mojang.com/mc/game/version_manifest_v2.json`, 918 entries): `release` 103, `snapshot` 754, `old_beta` 26, `old_alpha` 35. Note: **pre-releases and release candidates are typed `snapshot`** (e.g. `26.3-rc-3`, `1.21.5-rc2`) — there is no separate type.
- **Installability rule: modern snapshots expose `downloads.server` (`url/size/sha1`) with the same shape and hosts as releases** (verified for weeklies, RCs, current snapshots). No new download/verify path needed — the existing Vanilla artifact branch already handles both; only the `version_type == "release"` predicate excludes them. Exceptions are the `old_*` lines (e.g. `b1.7.3` is client-only, no `server` key) — keep excluding `old_alpha`/`old_beta`, fail clearly when `downloads.server` is absent.
- Single upstream filter today: `vanilla_manifest_entries` keeps only `release`; everything downstream (`resolve_vanilla_versions`, `resolve_paper_versions`, `resolve_loader_choices` release check, Vanilla install branch, Modrinth Fabric MC check) inherits it.
- DTO already carries `versionType` (`MinecraftVersionDto`); UI renders bare IDs with no type label and silently re-selects `[0]` on stale picks — both must change (labels + hold-and-notify, see implementation plan).

## 6. Product rules for the catalogue (applies to all providers)

- Gate on **artifact completeness**, not the advisory flag (`channel`/`stable`/promotion).
- Order stable first; label every non-stable row inline at the point of choice.
- Stable-by-default with an explicit persistent opt-in ("Show all builds"); never silently remap a stale selection — hold it, explain, and block Install until the user picks (Minecraft Launcher's own snapshot opt-in precedent).
- Exact-verify the selected build at install, revalidation, and publication; no substitution.

## Sources

- Paper: `https://docs.papermc.io/misc/downloads-service/`, `https://fill.papermc.io/v3/projects/paper/versions/1.21/builds`, `.../1.21.11/builds`, `.../9.9.9/builds`, `https://github.com/itzg/docker-minecraft-server/issues/3517` (official Fill v3 announcement quote)
- Fabric: `https://raw.githubusercontent.com/FabricMC/fabric-meta/master/README.md`, `https://meta.fabricmc.net/v2/versions/loader/1.21`, `.../1.21/0.19.4`, `.../1.21/0.0.0-unknown`, `.../9.9.9`, `.../1.21/0.16.14/1.0.3/server/jar`, `.../1.21/0.19.4/1.1.2/server/jar`, `https://meta.fabricmc.net/v2/versions/installer`
- Forge: `https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json`, `.../maven-metadata.json`, `https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml`, official `SimpleInstaller.java`, FML `README.txt`, `MinecraftForge` `build_forge.gradle`, `https://forums.minecraftforge.net/topic/55287-add-filesminecraftforgenet-json-api/`, itzg Forge docs + issue 1525
- NeoForge: `https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml`, `https://docs.neoforged.net/docs/gettingstarted/versioning/`, `https://docs.neoforged.net/user/docs/server/`, `CreateInstallerProfile.java`, LegacyInstaller/ServerStarterJar repos
- Mojang: version manifest + 8 version JSONs (snapshot/RC/weekly/old_beta/ancient), `https://www.minecraft.net/en-us/download/server`, launcher snapshot opt-in guide, 3 snapshot/RC articles
