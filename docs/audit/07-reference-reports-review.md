# Review — reference reports in `H:\TestAI\modrinth-curseforge`

Reviewed 2026-10-28 while wiring the Settings API-key/download-location request and the two install
failures from the UI screenshots. The reference project is the live proof for the installer engine this
app now ships; these are the reports that matter and how they map to this app.

## What the reports establish

| Report | Key facts used |
|---|---|
| `modpack-install-results.md` | The engine's live matrix is **12/12 PASS** (Modrinth 7/7, CurseForge 6/6) with real `Done (` boots; the 4-layer client-mod defense (L1 metadata, L2 jar self-declaration, L3 boot-auto-fix, L4 itzg curated data) is the proven approach; CurseForge keyless routes A/B work, and **browsing/searching needs the official API key** (Cloudflare blocks keyless search). Key-mode one-click resolves `serverPackFileId` and is the fastest CF path. |
| `.data/sweep-report.md` | The second live sweep: CF 6/6 (Dungeon Heroes, RLCraft 1.12.2/Java 8, SkyFactory 5, DawnCraft, Otherworld, Prominence II) all reached `Done (`. |
| `serverpack-tools.md` | Three server-pack shapes must be detected, never assumed: **prebuilt** (`run.bat`/`libraries` or `fabric-server-launch*.jar`), **script-driven** (setup script + own manifest), **plain** (`mods/` + `config/`, loader still to be installed). Old Forge (≤1.12) `--installServer` produces a directly runnable `forge-<mc>-<ver>.jar`; `fileId+1` server-pack discovery is not reliable (0/6). Server-pack ZIPs may lack `manifest.json` — classify and fail with an actionable message instead of guessing. |
| `modpacks.md` / `curseforge-policy.md` | Keyless: metadata/bytes work, no `serverPackFileId`, no hashes; 2 req/s posture; official API first when a user key exists; key is user-supplied only (never bundled). |
| `specs.md` | **D-03 user-chosen data root** (worlds get large), Settings must persist it across restarts (T-05); downloads land in a temp file and are renamed only after verification; paths must resolve inside managed roots. |
| `.zcode/plans/plan-session…md` | The original port plan confirms the engine integration and that CF key currently lives in `<dataRoot>/curseforge-key.txt` — the file-editing UX this request replaces. |

## Actions taken in this app from the review

1. **Settings → CurseForge API key** (was a hand-edited `curseforge-key.txt`): the key is entered in
   Settings, stored via `safeStorage` (app-data fallback is managed automatically), never echoed,
   bundled, logged, or included in support bundles. With a key, **Create → CurseForge modpacks**
   browses the official catalogue in-app (`curseforge_search_modpacks`, sort/paging) and selecting a
   pack resolves the latest file/`serverPackFileId` → one-click install; without a key the wizard
   points to Settings and keeps the manual SERVER-ZIP import path.
2. **Settings → Downloads & storage**: new user-selectable **download folder** (default
   `<dataRoot>/cache`, persisted in the JSON store, validated/write-probed, reset/open buttons).
   Installer/loader jars, Modrinth/CurseForge archives, cached Java zips and other download caches
   use it (runtime + pipeline); server folders, worlds and backups stay in the app data root. This
   implements the reference's user-chosen-location intent without moving live servers.
3. **EPERM when publishing a staged install** (`rename installer-staging\<id> → servers\<id>`):
   the publisher now retries transient Windows lock errors (EPERM/EACCES/EBUSY/ENOTEMPTY) with
   backoff, falls back to a private copy + rename when the direct rename still fails (also covers
   EXDEV), cleans up its temp folder, and reports a friendly `io` error if the tree truly cannot be
   moved. Unit tests cover retry-success and copy-fallback paths.
4. **CurseForge "server pack has neither a loader nor a manifest"**: pack classification now
   recognizes all documented prebuilt shapes (Forge/NeoForge run scripts/libraries, Fabric/Quilt
   launch jars, old Forge universal jar, plain vanilla `server.jar`). Manifest-less **Fabric/Quilt**
   packs install the newest stable loader from provider metadata instead of failing on a missing
   version; Forge/NeoForge without a version get an actionable error telling the user to use the
   author server pack or a manifest client ZIP. Plain packs with no MC metadata fail before any
   download with the same guidance instead of a generic message.

## Not changed / still open

- CurseForge key-mode missing-dependency fetch remains prune-only (reference: keyless search is
  blocked; key mode could fetch dependencies officially later).
- Script-driven server packs (`server-setup-config.yaml`) are classified/refused, not executed —
  running bundled scripts needs explicit user consent (reference P-2 decision).
- The `.data` reference tree itself was read only; nothing was copied into this repository except
  the curated data files that already shipped in earlier phases.
