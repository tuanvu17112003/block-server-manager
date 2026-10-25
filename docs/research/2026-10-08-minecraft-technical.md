# Research 2026-10-08 — Minecraft Technical (Explorer-mc, research-001-C)

## UI must support
- **Vanilla:** list from piston-meta, filter release/snapshot/old, show latest.release/snapshot, search id; resolve server.jar via version.url → downloads.server url+sha1+size; isolated folder, download as server.jar, first-run gen eula.txt + properties, block Start until eula=true; checkbox + minecraft.net/eula link, write eula.txt, log EULA fail.
- **Loaders:** picker Vanilla|Paper|Fabric|Forge|NeoForge|Quilt + MC + loader/build, only compatible combos. Modrinth-first no key (search project_type, versions filtered game_versions+loaders, .mrpack or .jar to mods/). CurseForge gated behind user x-api-key. Paper STABLE only default, paper-*.jar as server.jar. Fabric/Quilt/Forge/NeoForge installer jar headless (installServer / install server --download-server), capture logs, Java check first. Auto mods/ + deps (Fabric API/QFAPI), client-only warn.
- **Java:** detect (java -version, JAVA_HOME, registry, Adoptium/MS paths), map MC→major, auto-select or Temurin 8/17/21 64-bit (1.20.5+ 64-bit req), store javaPath per server + -Xms/-Xmx + user_jvm_args.txt (NeoForge).
- **Runtime/console/players:** minimal properties subset (see below) + validation + restart notice; server-icon.png 64x64 validate + motd preview; whitelist.json (Mojang api.mojang.com/users/profiles/minecraft/<name> → UUID) + ops.json levels 1-4 + banned-players/ips; live via RCON (whitelist/op/deop/ban/kick) + file fallback stopped; console attached stdin/stdout (best desktop) + RCON detached; tail logs/latest.log; stop graceful; RCON enable-rcon, port 25575 bind 127.0.0.1, generated password never logged, broadcast-rcon-to-ops; Query optional enable-query UDP.
- **Worlds/backups:** list by level-name + level.dat folders, seed/size/last; backup save-off + save-all flush via RCON/stdin, zip world(+_nether/_end) to backups/<server>-<date>.zip, save-on, retention + progress; restore stop→unzip temp→validate level.dat→replace or level-name→restart; warn backup before loader update; schedule interval/cron + on-stop + keep-N.
- **Metrics:** CPU/RAM via process (System.Diagnostics.Process WorkingSet/%CPU + JVM flags, JMX optional); players via list RCON/stdin authoritative or Query/SLP (enable-status) MOTD/version/icon; TPS vanilla none — parse Can't keep up! or Paper tps/mspt via RCON; don't promise TPS for vanilla/Forge/Fabric.

## APIs
| API | Endpoint | Auth | Use |
|---|---|---|---|
| Mojang piston-meta | GET piston-meta.mojang.com/mc/game/version_manifest_v2.json | none | latest + versions[{id,type,url}] |
| Mojang version pkg | GET <version.url> (.../v1/packages/<sha1>/<ver>.json) | none | downloads.server{sha1,size,url}, javaVersion{major,component} |
| Mojang data | GET piston-data.mojang.com/v1/objects/<sha1>/server.jar | none | jar bytes |
| Mojang profiles | GET api.mojang.com/users/profiles/minecraft/<name> | none | name→UUID |
| Paper Fill | GET fill.papermc.io/v3/projects/paper + /versions/{mc}/builds | User-Agent <proj>/<ver> (<contact>) | MC list, STABLE filter, downloads.server:default.url sha256 size |
| Paper legacy | GET api.papermc.io/v2/.../downloads/paper-{mc}-{n}.jar | same | direct (deprecated) |
| Modrinth v2 | GET api.modrinth.com/v2/search?query=&facets=[[project_type:modpack]] | User-Agent req, none reads | search |
| Modrinth | GET /v2/project/{id\|slug}, /v2/project/{id}/version?game_versions=&loaders=, /v2/version/{id}, POST /v2/version_files/update | mrp_... only write/private | versions, file url/hashes, update check |
| Modrinth tags | GET /v2/tag/game_version, /loader, /category | none+UA | dropdowns, 300/min/IP |
| CurseForge | GET api.curseforge.com/v1/mods/search?gameId=432&classId=4471&gameVersion=&modLoaderType=&searchFilter= | x-api-key REQUIRED console.curseforge.com | search gameId432 classId6mod 4471pack loader 1Forge 4Fabric 5Quilt 6NeoForge |
| CurseForge | GET /v1/mods/{id}, /files?..., /description, /minecraft/version, /modloader | same | details, downloadUrl, manifest |
| Fabric Meta | GET meta.fabricmc.net/v2/versions/game, /loader, /loader/{mc}, /loader/{mc}/{loader}/server/json, /installer | none | compat list, server JSON, installer ver |
| Fabric Maven | maven.fabricmc.net/net/fabricmc/fabric-installer/ | none | installer jar |
| Forge | files.minecraftforge.net/.../promotions_slim.json + maven.minecraftforge.net/... | none (scrape) | recommended/latest, --installServer |
| NeoForge | GET maven.neoforged.net/releases/net/neoforged/neoforge/ → ...-installer.jar | none | --installServer → run.bat + user_jvm_args.txt |
| Quilt Meta v3 | GET meta.quiltmc.org/v3/versions/game, /loader, /loader/{mc}, /.../server/json, /installer | User-Agent req | like Fabric, CLI install server --download-server → quilt-server-launch.jar |

## Java map (verified: cutoff 1.20.5 not 1.20.6)
| MC | Min Java |
|---|---|
| 1.8-1.16.5 | 8 (64-bit rec) |
| 1.17-1.17.1 | 16 |
| 1.18-1.20.4 | 17 |
| 1.20.5-1.21.x/26.x | 21 + 64-bit required |
Rule: never hardcode 1.20.6; read javaVersion.majorVersion per version JSON + fallback table.

## Minimal server.properties
server-port 25565, server-ip blank, motd, max-players 20 (1-100), online-mode true (false warns piracy+UUID break), white-list false + enforce-whitelist false, difficulty, gamemode, force-gamemode false, hardcore false, pvp true, level-name world, level-seed, generate-structures true, view-distance 10 (2-32), simulation-distance 10, spawn-protection 16, max-world-size, enable-command-block false, allow-flight false, player-idle-timeout 0, enable-rcon false + rcon.port 25575 + rcon.password gen + broadcast true, enable-query false + query.port, enable-status true, compression 256, op-level 4, function-level 2, resource-pack (+sha1). Related: eula.txt, server-icon.png, whitelist/ops/banned jsons, logs/latest.log, user_jvm_args.txt, run.bat.

## Risks
CF key (provision console.curseforge.com, no shared ship, user field + rate-limit + MR fallback, respect CDN ToS); EULA (no auto-accept, checkbox + store); large downloads (30-60MB vanilla/Paper, 100-300MB Forge/Neo + libs, GBs packs — progress/resume/SHA verify/disk check/Defender 25565 TCP open, 25575 localhost only RCON cleartext); compat drift (Forge→NeoForge 1.21+, QSL reduced, Paper EXPERIMENTAL unstable, piston-data + fill-data URLs expire — resolve fresh cache short); Windows (spaces/long paths/multi-Java bitness/port conflict/run.bat vs sh/log locks).
