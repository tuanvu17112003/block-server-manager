# Live acceptance matrix — app vs reference spike

Generated 2026-10-29T07:23:43.492Z by `node node_modules/electron/cli.js . --matrixtest`.
Reference: `H:\TestAI\modrinth-curseforge\modpack-install-results.md` (the spike's own sweep).

**12/12 packs PASS** through this app's real pipeline (staged install → L2/L3 verified boot → publish).

| Pack | Platform | Loader (app) | Expected | Verified boot | Jars (enabled/disabled) | Reference | Verdict |
|---|---|---|---|---|---|---|---|
| battlearmorytacz | modrinth | forge 1.20.1 | forge 1.20.1 | complete | 60/20 (ref 88) | PASS Done(8.638s) | **PASS** |
| cobbleverse | modrinth | fabric 1.21.1 | fabric 1.21.1 | complete | 100/14 (ref 168) | PASS Done(9.670s) | **PASS** |
| dawn-craft | curseforge | forge 1.18.2 | forge 1.18.2 | complete | 249/2 (ref 278) | PASS Done(71.137s) | **PASS** |
| dungeon-heroes | curseforge | fabric 1.21.1 | fabric 1.21.1 | complete | 187/0 (ref 214) | PASS Done(50.984s) | **PASS** |
| otherworld-dnd | curseforge | forge 1.20.1 | forge 1.20.1 | complete | 356/0 (ref 377) | PASS Done(44.789s) | **PASS** |
| prominence-2-fabric | modrinth | fabric 1.20.1 | fabric 1.20.1 | complete | 348/15 (ref 341) | PASS Done(37.310s) | **PASS** |
| prominence-2-hasturian-era | curseforge | fabric 1.20.1 | fabric 1.20.1 | complete | 368/5 (ref 576) | PASS Done(34.511s) | **PASS** |
| rlcraft | curseforge | forge 1.12.2 | forge 1.12.2 | complete | 178/0 (ref 182) | PASS Done(11.237s) | **PASS** |
| skyblock-enhanced | modrinth | fabric 26.2 | fabric 26.2 | complete | 13/2 (ref 15) | PASS Done(2.044s) | **PASS** |
| skyfactory-5 | curseforge | forge 1.20.1 | forge 1.20.1 | complete | 262/2 (ref 268) | PASS Done(7.231s) | **PASS** |
| slimes-adventure | modrinth | fabric 1.21.1 | fabric 1.21.1 | complete | 115/4 (ref 105) | PASS Done(11.502s) | **PASS** |
| zombie-invade-100-days | modrinth | forge 1.20.1 | forge 1.20.1 | complete | 97/21 | PASS Done(21.694s) | **PASS** |

Per-pack evidence JSON (preview plan, report stages/files, published counts) sits beside this file.
