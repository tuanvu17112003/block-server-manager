# Spec — Management & content tabs (post-migration)

Status: implemented 2026-10-26 (Phase 5/6 of `docs/electron-completion-plan.md`). These features are new
relative to the dormant Tauri tree (its modules were empty stubs); the contract below is the source of
truth for the Electron services and UI.

## Content (mods/plugins)
- Loader-aware: Paper serves plugins (`plugins/`, Modrinth `project_type:plugin`), other loaders serve mods.
- Enable/disable is a reversible rename into `<mods|plugins>-disabled/` and requires a stopped/crashed
  server; removal is permanent and idle-only. Changes apply on the next start.
- Install/update is transactional: downloads are verified (size/SHA-256) into staging names; an existing
  project version's files (including disabled copies) are moved to a per-install trash; the new version is
  published (dependencies first, primary last) inside one synchronous rename block; metadata is written
  after publish; any failure/cancel restores the old tree. `content_install` is a cancellable job
  (`content_install_cancel`); `installed/files/warnings/skipped` are reported.
- Required Modrinth dependencies are resolved (project-id first, then search), filtered by game version and
  the plugin loader union (`paper/spigot/bukkit/purpur/folia`) for plugins. Client-only projects are
  rejected/skipped; dependencies already present (active or disabled) are not re-installed.
- Search/version lists are server-scoped; no silent mock data.

## Backups
- Backup kinds: `Manual`, `Auto`, `Pre-install`, `Pre-restore`, `World-delete`. Archives contain the active
  world + nether/end + config files (not mods/plugins/logs/cache); excluded paths are shown in the UI.
- `backup_create` supports `shutdownDuring` (graceful stop → consistent archive → restart) and jobId
  progress. Running backups send `save-off`/`save-all flush` and wait (bounded, sequence-based) for the
  save acknowledgement before archiving; `save-on` always runs.
- Schedule: `auto`, interval `Hourly|Daily|Weekly`, `maxKept` clamped 1–50. Retention keeps the newest
  `maxKept` Manual/Auto archives, a bounded safety pool (Pre-install/Pre-restore: 2 each) and bounded
  World-delete archives (5), never pruning the just-created file.
- Restore: `in-place` overlays the archive; `reset` replaces the level; both take a Pre-restore safety copy
  first and are idle-only. Export/Delete do not require a stopped server.

## Worlds
- Discovery scans server folders for `level.dat`; world units include `<world>_nether`/`<world>_the_end`;
  parsed `level.dat` exposes name/seed/version (corrupt files raise a warning).
- Activate (idle-only) takes an automatic backup and rewrites `level-name`; New world writes
  `level-name`/`level-seed`/`level-type` for the next start and is shown as a pending "next start" world.
- Duplicate/export/import operate on the whole world unit (dimensions included); import accepts root
  `level.dat`, a single level folder, or a server-style archive, rejects mixed/unsafe layouts, and never
  overwrites an existing world (unique names). All three accept `jobId` and emit progress; export requires
  a stopped server.
- Pending worlds clear once the folder exists after a start; they cannot be deleted/activated.

## Players
- Roster comes from `ops.json`/`whitelist.json`/`banned-players.json`/usercache plus `latest.log`
  (vanilla/Fabric, Forge/NeoForge and Paper formats) for last-seen/playtime.
- Online list uses the server `list` reply tracked by a monotonic log sequence (works when the console
  ring is saturated); max players comes from `server.properties`.
- Offline (stopped) actions: whitelist add/remove, OP/de-OP, ban/unban edit the JSON files atomically using
  usercache/Mojang name→UUID resolution (cached, timeout/429 safe). Kick/gamemode/teleport/heal require a
  running server and are disabled with a tooltip otherwise.

## Metrics
- One batched `Get-Process` sample per 5 s covers every running server; CPU is normalised by logical cores
  (Task Manager parity) and RAM is the working set; uptime/players/TPS come from the process manager.
  Paper servers receive a `tps` command at most once per 30 s; MSPT is shown only from a real log line.
- History is one sample per minute, retained 7 days, `hours` must be an integer 1–168; history/disk are
  available while stopped (empty state in the UI), maps are pruned for stopped/deleted servers.

## Settings
Two separate surfaces:

1. **Server Settings tab** (per active server): file-authoritative 7-field subset (`name`, `motd`,
   `max-players`, `difficulty`, `gamemode`, port, `online-mode`) + RAM + EULA + this server's Java
   runtime; atomic save (validation before writes, rollback on failure) that never stops a running
   server unless the EULA itself changes; restart badge; advanced-files shortcuts; Danger zone
   (delete this server). `eula.txt` truth and the stored flag must both say accepted to start
   (`eula=false` wins; never auto-accepted).
2. **App settings** (global, sidebar entry, independent of the active server):
   - **CurseForge API key** — stored in `safeStorage` (or the managed app-data fallback — users never
     edit files by hand), never displayed in full, never bundled/logged, optional (keyless routes
     work). With a key saved, **Create → CurseForge modpacks** browses the official catalogue in-app
     (`curseforge_search_modpacks`: query + sort + paging), and selecting a hit resolves the latest
     file / `serverPackFileId` and continues to the one-click configure/install flow. Without a key the
     wizard shows the Settings pointer plus the manual ZIP import path.
   - **Downloads & storage** — folder for manager downloads (installer/loader jars, Modrinth/CurseForge
     archives, cached Java zips): default `<dataRoot>/cache`, any absolute writable path except
     manager-managed folders (servers/backups/runtime/staging/logs); persisted in the JSON store,
     write-probed before saving, with Reset-to-default and Open-folder actions. Applies to future
     downloads only; server folders, worlds and backups remain in the app data root (shown there).
   - **CurseForge download retention** — auto-delete staged ZIP copies after successful installation
     (off by default; the original user file is never deleted).
   - **Diagnostics** — redacting support bundle (no worlds/mods/backups/secrets).

## Cross-cutting
- Command surface (76 renderer commands), shared contract lists, `{code,message}` error envelope, and
  sender-frame/IPC arg validation are defined in `shared/contracts.ts` + `electron/services/validate-ipc.ts`.
- Real UI E2E seeds these services and asserts the tab contract; see `docs/verification.md`.
