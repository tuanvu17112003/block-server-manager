# Frontend audit

Scope: React renderer (`src/`), compared with `docs/specs/*`, `docs/implementation/*`, the dormant Rust
reference (`src-tauri/src`) and Electron main-process handlers (read-only cross-check). Reviewed the
uncommitted wave: `git diff -- src/` (12 files, +1128/−156) plus new `src/tabs/Content.tsx`.
Confidence tags: **confirmed** = proven from source; **likely** = contract/behaviour inference needing a
runtime or network observation; **needs runtime check** = timing/UI-state dependent.

## Executive summary

- **The modpack install path is broken in the UI**: any `modpack_pipeline_install` result (success *or*
  failure) stores a report without `loader`, and Create dereferences `pipelineReport.loader.minecraftVersion`
  unguarded. No ErrorBoundary exists, so the whole window goes blank (F-01).
- **Two cross-layer contract mismatches break everyday features**: Settings always sends `eulaAccepted`, so
  saving while running stops the server (F-02); Electron `java_detect`/`java_validate` return `javapath`
  while the renderer expects `path`, blanking detected paths and breaking the Java override (F-03).
- The new management tabs are genuinely wired to Electron commands, but their loaders are un-cancelled, every
  mutation forces the whole shell through "Loading servers…", and several spec affordances are missing/fake
  (F-06…F-18).
- `Create.tsx` is a 2,542-line component (~86 `useState` mentions, 13 effects) mixing three provider flows,
  mock/backend modes, and preview/install/report state with no cleanup (F-04, F-21).
- Mock/stub fallbacks are unreachable under a *working* preload but are reachable and **silent** if the preload
  fails: the packaged app would show fake servers instead of an error (F-11). Browser mocks remain for every tab
  except Content (no mock at all).
- Specs and gates did not follow the wave: `app-tabs.md` still says 7 tabs (8 exist), the framework-neutral
  command list omits all new commands, and no gate exercises the new tabs or the pipeline report render — so
  the P0 passes `selftest`/`mgmttest`/`e2e`/`ipctest`.

## Findings

### P0

#### F-01 — Modpack install report crashes the renderer (blank app) after any pipeline result
**P0 · confirmed.**
**Evidence:** `electron/services/pipeline.ts:36` types the report as only `{status, stages, files, warnings, errors}`;
`:187`/`:200` return it as-is. `src/tabs/Create.tsx:1076` stores it, `Create.tsx:2381-2396` renders
`pipelineReport.loader.minecraftVersion/.kind/.loaderVersion`; the intended DTO includes `loader`, `planId`,
`serverId`, `createdAt`, `schemaVersion`, `sourcePin` (`src-tauri/src/modpacks/pipeline/report.rs:100-113`).
No ErrorBoundary exists (`src/main.tsx:10-15`; grep `ErrorBoundary|componentDidCatch` has no hits).
**Symptom:** after a Modrinth/CurseForge install completes, fails, or is cancelled at step 4, React throws
`TypeError: Cannot read properties of undefined (reading 'minecraftVersion')` and the whole app unmounts. The
server record may already be added (`Create.tsx:1081`), so only reload/restart recovers.
**Root cause:** TS port returns a reduced report instead of the Rust `InstallReport` the renderer's
`PipelineInstallReport` type mirrors (`tauri.ts:392-411`); the renderer trusts the type across a cast IPC boundary.
**Impact:** every modpack creation ends in a crashed UI on the success path; report, Done navigation, Retry and
parity notice are unreachable; gates stay green because they call handlers, not this render.
**Fix:** emit the full report (or widen the type and make the renderer defensive: `pipelineReport.loader?.…`);
add a top-level ErrorBoundary; stop casting `unknown` IPC results.
**Verify:** run a Modrinth remote (and CurseForge ZIP) install through the real UI to step 4; repeat for forced
failure and cancel.

### P1

#### F-02 — Saving Settings while the server is running silently stops it
**P1 · confirmed.**
**Evidence:** `Settings.tsx:284` always sends `{ name, ramMb, eulaAccepted: eula }`;
`electron/services/properties.ts:260-266` does `if (typeof a.eulaAccepted === 'boolean') { if (running||starting)
await stopServer(id); … }` with no "changed?" check. The UI only promises a restart banner (`Settings.tsx:302-306`).
**Symptom:** editing MOTD/RAM/port on a running server and pressing Save triggers a graceful server stop, drops
players, toasts "Settings saved", then asks for a restart.
**Root cause:** renderer includes `eulaAccepted` in every save payload; backend treats presence of the boolean as
an explicit EULA decision (its stop-before-write guard).
**Impact:** unexpected downtime from a benign save; contradicts app-tabs "dirty Save + Restart banner".
**Fix:** send `eulaAccepted` only when it changed (or add an explicit change flag); make backend skip when equal.
**Verify:** start a server, edit MOTD only, Save, observe whether the process stops.

#### F-03 — Java runtime path DTO mismatch: blank path, unusable per-server override
**P1 · confirmed (field mismatch); likely (full override sequence, depends on JDK location).**
**Evidence:** backend `JavaRuntime` is `{major, javapath, source}` (`installer/core.ts:166,181,190`) and
`java_detect`/`java_validate` return it (`runtime.ts:55-68`); renderer `JavaCandidate` is
`{path, major, architectureBits, source}` (`tauri.ts:225-230`) and reads `.path` at `Create.tsx:811-817,2300,
294/300,1160-1163`, `Settings.tsx:203-215,382`. Only `java_ensure` maps `{path: rt.javapath}`
(`runtime.ts:75`), so "Install Temurin" works while detection/validation do not. `java_validate` also only
accepts paths already found by `detectJava` in JAVA_HOME/PATH/standard folders/`<dataRoot>/runtime`
(`runtime.ts:61-67`), not arbitrary user paths.
**Symptom:** (a) blank path line after detection; (b) Create "Validate path" sets `javaOverride` but stores an
empty path, so `javaSelected.path === javaPath.trim()` (`Create.tsx:294,300,2358`) stays false and Install stays
disabled; (c) Settings "Validate and save path" passes `undefined` → `ipc.ts:47` coerces to `null` → override
silently cleared with a "cleared" toast; custom JDKs are rejected.
**Root cause:** TS port renamed the Rust DTO field; renderer not updated; TypeScript cannot catch this across
the cast-based IPC boundary.
**Impact:** per-server Java override unusable; misleading Java state; pipeline/standalone installs record
`javaPath: undefined` (`Create.tsx:1048,1229`) and silently auto-resolve.
**Fix:** normalise at the adapter (`{path: javapath, …}`) and validate the given path by spawning `-version`.
**Verify:** auto-detect path displayed; Change… with a JDK outside standard roots (expect success); validate a
JAVA_HOME path (expect not cleared); reload and confirm persistence.

#### F-04 — Create wizard has no recovery from catalogue/Java discovery failures (forced first-run dead end)
**P1 · confirmed.**
**Evidence:** `Create.tsx:699-727` loads vanilla/paper versions once with `[]` deps; on failure it only sets
`versionsError` (shown at `2224-2226`) and never retries. Java detection (`Create.tsx:797-832`) also has no
retry. With an empty DB the app force-shows Create (`App.tsx:23-26`) and Cancel is suppressed (`App.tsx:43-44`).
**Symptom:** a transient Mojang/Paper/Adoptium/network failure leaves step 3 with unavailable metadata, disabled
selects/Install, and no way out on first run except restarting the app.
**Root cause:** one-shot effects without retry, combined with the first-run Create lock.
**Impact:** new users on flaky networks are trapped.
**Fix:** add Retry buttons wired to retry counters (pattern already exists at `Create.tsx:161-176`); allow
Back/Cancel on first run with an empty-state Overview CTA.
**Verify:** block network, open with an empty data root, retry after restoring; no app restart needed.

### P2

#### F-05 — Optional Modrinth files are not "keep by default"; install stays blocked until each is chosen
**P2 · confirmed contract drift; likely user-visible when a pack marks files `env.server=optional`.**
**Evidence:** renderer seeds defaults only for `reason === 'optionalDefaultKeep'` (`Create.tsx:911-917`) and
blocks on unresolved `awaitingUserChoice` (`Create.tsx:1015-1021,1413-1415,2355-2358`), rendering them as
unchecked radios (`Create.tsx:2019-2035`) with "conflicting file" copy (`:1020`). TS pipeline marks every
optional file `action:'awaitingUserChoice', reason:'userChoice'` (`pipeline.ts:74-75`), while the intended
contract defaults optional files to include/`optionalDefaultKeep` and only conflicts to
`awaitingUserChoice`/`conflictingSignals` (`src-tauri/src/modpacks/pipeline/selection.rs:111-130`,
`model.rs:209-236`).
**Symptom:** packs with optional server files force Include/Exclude clicks for each file (default-keep files are
not selected), and can't install until every one is touched.
**Fix:** emit `optionalDefaultKeep` for optional defaults (and `conflictingSignals` for real conflicts) in the TS
pipeline, or default the renderer's choices to include for optional entries.
**Verify:** preview a pack with optional entries; checkboxes start checked, Install enabled without edits.

#### F-06 — Every management mutation tears the shell down to the "Loading servers" screen
**P2 · confirmed.**
**Evidence:** `store.tsx:366-392` sets `serversHydrated=false` on each `reloadServers()`; `App.tsx:23-26,68-76`
renders the full-screen loading branch, unmounting the current tab until the list returns. Callers:
`Settings.tsx:288,472`; `Worlds.tsx:100,120,132,143`; `Backups.tsx:137`.
**Symptom:** activating a world or saving settings replaces header/tab content with "Loading saved servers…";
scroll/dialog state is lost; visible flicker on slow disks.
**Root cause:** one hydration flag covers first load and background refresh.
**Fix:** separate `refreshing` from `serversHydrated`; refresh silently after mutations.
**Verify:** activate a world; the tab must stay mounted.

#### F-07 — Management tab loaders and Content search are not request-safe (stale data on server switch)
**P2 · likely (race; needs slow backend to observe).**
**Evidence:** no cancellation/request-id guard in `Players.tsx:30-49`, `Worlds.tsx:56-76`, `Backups.tsx:46-67`,
`Metrics.tsx:42-57`; Content search/versions overwrite newer state unconditionally (`Content.tsx:66-95`).
Contrast `Settings.tsx:83-109,111-150`, which does use a `cancelled` flag.
**Symptom:** switching servers quickly can display the previous server's roster/worlds/backups/metrics; a new
Content query can be overwritten by the previous result; old failures can replace new successes.
**Impact:** wrong data shown for the selected server; user may act on the wrong server's rows.
**Fix:** shared `useServerRequest` hook with request id/cleanup (Settings pattern); abort on `active.id` change.
**Verify:** throttle IPC, switch servers mid-load; rows must match the header server.

#### F-08 — Deleting the active server leaves a stale `activeId`
**P2 · confirmed.**
**Evidence:** `store.tsx:383` keeps `activeId` if non-empty while `reloadServers` replaces the list;
`Settings.tsx:464-475` never calls `select(...)` after deleting. `active` falls back to `servers[0]`
(`store.tsx:513`) but effects keyed on `activeId` (`store.tsx:404-424`) keep querying the deleted id (errors
silently swallowed).
**Symptom:** header can show server B while console history/tail effects target deleted id A; `EMPTY_SERVER` may
flash.
**Fix:** after a successful list, clamp `activeId` to loaded ids.
**Verify:** delete the active server among several; inspect Console history/tail.

#### F-09 — Settings save is not atomic: server.properties is written before name/RAM validation rejects
**P2 · confirmed.**
**Evidence:** `properties.ts:240-268`: `writePropertyValues` at `:246`, then name-clash (`:249-253`) and RAM
validation (`:255-259`) can throw; the renderer toasts the error and keeps the form dirty (`Settings.tsx:290-297`)
although the file already changed.
**Symptom:** rename to a duplicate name → error, but MOTD/port/etc. from the same save were applied.
**Fix:** validate name/RAM/EULA before writing, or stage everything and write after validation.
**Verify:** duplicate name + distinctive port, Save, restart, inspect `server.properties`.

#### F-10 — Install cancellation is coarse and Back exits mid-install (orphaned job/preview)
**P2 · confirmed UI paths; likely backend abort granularity.**
**Evidence:** `CreateHeader` Back is always enabled (`layout.tsx:144-156`, used at `App.tsx:63`); in-install
Cancel exists only at step 4 (`Create.tsx:2455-2467`). `cancelInstall` (`Create.tsx:1307-1338`) only flags
cancellation; backend checks cancel at a few checkpoints (`runtime.ts:99,103`, `pipeline.ts:140,177`) and
`server_install_cancel` merely calls `jobs.cancel`, which does not abort an in-flight `installLoader`/download.
On unmount only the local `.mrpack` is released (`Create.tsx:496-501`); a held pipeline preview is never
discarded (`clearPipelineReview` is not called on unmount, `Create.tsx:333-343`).
**Symptom:** Back mid-install hides the wizard while the install continues and may persist a server with no
completion UI; revisits spawn fresh jobs while old ones run; backend preview map grows with abandoned previews.
**Fix:** disable Back while installing (or prompt), discard preview on unmount, pass an AbortSignal so Cancel is
prompt.
**Verify:** start a large install, click Back immediately; inspect `.app-data/servers` and main-process logs.

#### F-11 — A failed Electron preload silently activates browser mocks in the packaged app
**P2 · confirmed code path; needs packaging runtime check.**
**Evidence:** `hasBackend()` is `isElectron() || isTauri() || isHttpBackendConfigured()` (`tauri.ts:45-47`) and
`isElectron()` depends solely on `window.electronAPI` (`tauri.ts:16-18`). If the preload fails (missing
`dist-electron/preload.js`, sandbox/contextBridge error), the store initialises mock data (`store.tsx:126-135`,
`src/mocks/data.ts`) and every tab takes its `!backend` branch. Nothing logs a fatal state.
**Symptom:** desktop app shows three fake servers and simulated start/logs/actions instead of an error; the user
believes actions succeeded.
**Root cause:** mock mode selected by absence of the bridge rather than an explicit dev flag/handshake.
**Fix:** preload handshake with a visible fail-closed error screen in Electron; enable mocks only in dev/`?mock`.
**Verify:** rename `dist-electron/preload.js`, launch packaged app; expect explicit error, not mock servers.

#### F-12 — Worlds export/download is enabled when the backend requires a stopped server
**P2 · confirmed.**
**Evidence:** Download buttons are always enabled (`Worlds.tsx:187,222`, pending world included via `current`),
while `world_export` calls `requireIdle` and throws `conflict` when running (`electron/services/worlds.ts:174-176`).
Activate/Duplicate/Delete are gated by `stopped` (`Worlds.tsx:188,219-224`), so only export is inconsistent.
**Symptom:** Download on a running server → red conflict toast; Download on a pending next-start world errors
because its folder does not exist.
**Fix:** disable export unless `stopped`; hide export for `pending` worlds.

#### F-13 — Content tab: Paper plugin version lookup filters by `loaders=["paper"]`, likely always empty
**P2 · likely (depends on Modrinth tagging).**
**Evidence:** `electron/services/content.ts:205-209` forces `loader='paper'` for plugin servers and queries
`?loaders=["paper"]`; most Bukkit/Spigot plugins on Modrinth are tagged `bukkit`/`spigot`/`purpur`/`paper`
subsets. The UI then shows "No version supports Minecraft … on Paper" (`Content.tsx:262-264`), so install cannot
proceed.
**Fix:** query the union `["paper","spigot","bukkit","purpur","folia"]` for plugins (or retry progressively).
**Verify:** Paper server → Content → search a Spigot/Bukkit-tagged plugin (e.g. EssentialsX); versions list.

### P3

#### F-14 — CurseForge staged ZIP timestamps are off by ×1000
**P3 · confirmed.** Service returns `st.mtimeMs` (`curseforge-staging.ts:55,67`); renderer multiplies by 1000
(`Create.tsx:1682`), while the dormant Rust contract used seconds (`curseforge_import.rs:244-248`, `as_secs`).
Staged ZIP rows show dates around year 57000. **Fix:** return seconds (or stop multiplying) with one documented
contract. **Verify:** compare Create step 2 modified time with Explorer.

#### F-15 — Metrics: disk hidden unless TPS is missing; "undefined" MSPT; dead RCON promise
**P3 · confirmed.** `Metrics.tsx:88` sets `needsRcon = tps===null`; disk renders only inside that block
(`:107-112`); `:101` prints `${tps?.toFixed(1)} / ${mspt?.toFixed(1)}` → "20.0 / undefined" when TPS exists
without MSPT; the hint promises the backend will connect although RCON is permanently deferred (ADR-0011).
**Fix:** render disk unconditionally, format null as "—", reword the RCON hint.

#### F-16 — Auto-backup schedule UI has no rollback on rejection and can submit invalid values
**P3 · confirmed.** `Backups.tsx:69-76` updates optimistically, `.then(setSchedule)` but only an error toast on
failure (no revert); `:182` uses `Number(value)` so an empty field becomes 0; backend clamps 1..50
(`backups.ts:273-283`). **Fix:** restore previous schedule in `catch`, validate before sending.

#### F-17 — Players tab diverges from the spec (disabled-when-stopped, reasons, confirmations)
**P3 · confirmed.** Spec says "Disabled when stopped + tooltip" (`app-tabs.md:21`); implementation loads the
disk roster with a banner (`Players.tsx:130-137`). Kick/Ban use hardcoded reasons (`:160,163`); OP/Whitelist/
Gamemode/Heal have no confirmation (`:164-177`). **Fix:** align UI or spec; add reason prompt and confirmations.

#### F-18 — Backups spec affordance missing: "shutdown-during"
**P3 · confirmed.** Spec `app-tabs.md:27` asks for "Backup Now (name + shutdown-during)"; modal is name-only
(`Backups.tsx:223-233`) and always uses save-off/flush (`backups.ts:130-140`). **Fix:** add the checkbox and
restart-afterwards behaviour, or amend the spec.

#### F-19 — Backend error `{code}` is discarded by every toast; error helper duplicated 5×
**P3 · confirmed.** `store.tsx:115-123` returns only `message` although the adapter reconstructs code
(`tauri.ts:20-33`); duplicated helpers in `Players.tsx:8-12`, `Worlds.tsx:9-13`, `Backups.tsx:9-13`,
`Content.tsx:8-12`, plus inline copies in Settings/Metrics. Codes (`conflict`/`validation`/`not-found`) never
reach the UI/logs. **Fix:** shared `toErrorMessage(err)` exposing `{code,message}`; delete duplicates.

#### F-20 — Create port conflict is advisory only; standalone install does not re-check the port
**P3 · confirmed UI; likely duplicate-port Start failure.** Conflict is computed but never blocks
(`Create.tsx:322-326,2281-2285`); default port is hardcoded 25568 per session (`Create.tsx:206`); `server_install`
writes the requested port without `freePort` (`runtime.ts:105-107`) while pipeline does free it
(`pipeline.ts:179`). Copy says "The backend checks the port again during publication". **Fix:** call `port_check`
before publish or block on conflict.

#### F-21 — `Create.tsx` is an unmaintainable monolith (2,542 lines, ~86 `useState` mentions, 13 effects)
**P3 · confirmed.** One component owns wizard steps, three provider flows, CF staging/download UI, preview/choice/
report UI, Java detect/install, versions/loaders, and mock mode. Duplicated state: `javaPath`/`javaSelected`/
`javaOverride`; `pipelinePreview`/`pipelinePreviewKey`; `installJobId`/`installingRef`/`installRequestStartedRef`/
`cancelRequestedRef`; `kind` vs `serverLoader`. No unmount cleanup for `installTimerRef` (`Create.tsx:1294-1304`,
mock-mode interval survives Back); `pipelineReport` persists across wizard restarts. **Impact:** regression risk —
this wave produced F-01/F-05/F-09 in this file. **Fix:** split into `create/` per-source state machines, a shared
job-progress hook, and a typed preview/install subcomponent.

#### F-22 — Modals and Field labels are not accessible / invalid HTML
**P3 · confirmed.** `Confirm`/`Modal` (`components/ui.tsx:112-173`) lack `role="dialog"`, `aria-modal`, Escape,
focus trap and initial focus; `Field` renders a `<label>` wrapper (`ui.tsx:80-88`) and Create nests interactive
`<label>`s inside it (`Create.tsx:2200-2232`), which is invalid nested-label markup and can double-activate.
**Fix:** dialog semantics + Escape/scrim/focus management; make `Field` a `<div>` with explicit `htmlFor`.
**Verify:** keyboard-only modal pass; Esc close; focus trap.

#### F-23 — Minor spec/UX gaps: first-run Back no-op, Overview toolbar, banners, tab set
**P3 · confirmed.** First-run Back is enabled but `cancelCreate` returns early on empty DB (`App.tsx:43-48`,
`layout.tsx:150`) — a button that does nothing. Overview lacks the Kill action and port alert banner
(`app-tabs.md:8`); Kill exists only in the running header (`layout.tsx:105-123`). `app-tabs.md:5` still says
7 tabs while `layout.tsx:6-15` registers 8 (Content, intentional per `electron-port-plan.md:91`, spec not
updated; `types.ts:92-100`). **Fix:** hide/disable Back with tooltip, add Kill/port banner (or update spec),
document the 8-tab contract.

## Unmigrated / mock / stub inventory

- **Reachable under a working Electron preload:** none of the mock branches (all gated on `hasBackend()`/`!backend`).
  However **F-11**: a missing/throwing preload leaves `window.electronAPI` undefined, so the app silently runs
  `src/mocks/data.ts` — `initialServers`, `initialLogs`, `tickLogPool`, `initialPlayers`, `initialWorlds`,
  `initialBackups`, `metricsMock`, `modpacks`, `MC_VERSIONS`, `LOADERS` — with fake Start/Stop, fake player/world/
  backup actions, fake console replies, and fake progress.
- **Browser/dev mock mode (still shipped in the web build):** store mocks (`store.tsx:126-135,488-510`), Create
  (`Create.tsx:251-263,1624-1641,2506-2538`, incl. "Simulate finish (mock)"), Players/Worlds/Backups/Metrics/
  Settings mock paths, console mock replies (`store.tsx:300-306`) and "(mock)" toasts (`ConsoleTab.tsx:101`).
  `Content` has **no** mock fallback and shows "needs the desktop backend" (`Content.tsx:145-147`) in web builds.
- **Fake claims in real UI:** Console "attached" is just `running` (`ConsoleTab.tsx:34-35`); Export toast says
  "(mock)" though it really exports (`ConsoleTab.tsx:101`); Metrics "Shift-zoom on graphs arrives with the
  backend" (`Metrics.tsx:119`) and "Notify me (mock)" (`:135`) are dead placeholders; the RCON hint is unreachable.
- **Dead adapter/legacy surface:** `@tauri-apps/api` still a runtime dependency and eagerly imported
  (`tauri.ts:3-4`, `package.json:20`); Tauri `invoke`/`listen` and HTTP `invokeHttp`/`subscribeHttp`/`uploadHttp`
  branches remain but are unreachable in Electron (`tauri.ts:450-484,695-700`, `src/backend/http.ts`,
  `src/backend/config.ts`). `stubInvoke` is only reachable through unused `ping`/`server_get` (`tauri.ts:486-495`).
  Unused wrappers: `ping`, `tauriServers.get`, `tauriServer.backupNow`, `tauriServer.restoreBackup`,
  `tauriMetrics.disk`; preload `pickMrpack`/`pickZip`/`openExternal` are untyped and unused; duplicate
  `dialog:pick-zip` handler (`electron/ipc.ts:75-80` vs `curseforge_pick_zip`).
- **Stale HTTP contract:** `docs/specs/framework-neutral-backend-api.md:37` lists 32 commands and says some UI
  still uses mocks; the wave added `players_*`, `worlds_*`, `backups_*`, `metrics_get`, `system_disk`, `content_*`,
  `server_settings_*`, `port_check`, `server_open_folder`, `curseforge_inspect_project`, `curseforge_pick_zip`
  wrappers (`tauri.ts:493-568`) that no HTTP backend is specified to implement — web export errors on the new tabs
  once `apiBaseUrl` is configured.
- **Null/undefined DTO fields never populated:** `worldSizeMb` (Overview always "world (0 MB)"), `worldLastPlayed`,
  `seed`, real `address` (hardcoded 127.0.0.1); `modpack` display name lost on reload (only `modpackId` mapped,
  `store.tsx:95`). `tps`/`mspt` stay null unless a server writes TPS lines (backend only injects `list`), so
  Metrics always lands in the RCON-missing state.

## Runtime verification needed by Lead

1. **Modpack install (F-01):** Modrinth remote (e.g. Cobbleverse) → preview → install; watch DevTools for
   `Cannot read properties of undefined (reading 'minecraftVersion')` and a blank window; repeat forced failure
   and cancel-after-publish; also CurseForge ZIP path.
2. **Settings save while running (F-02):** start server, edit MOTD only, Save, observe stop/players dropped.
3. **Java (F-03/F-04):** detected path displayed? Change… custom JDK outside standard roots (expect success),
   JAVA_HOME path (expect not cleared), Install Temurin (expect persisted). Create with network blocked → retry?
4. **Optional files (F-05):** preview a pack with `env.server=optional`; defaults checked and Install enabled.
5. **Shell flicker (F-06):** activate a world / save settings; watch for "Loading saved servers…".
6. **Stale data (F-07/F-08):** rapid server switching during scans; delete active server, inspect Console.
7. **Cancellation (F-09):** Back immediately after starting an install; check orphan job/staging/record.
8. **Preload failure (F-11):** launch with `preload.js` temporarily missing; confirm whether mock servers appear
   (safety-critical; restore afterwards).
9. **F-12–F-16:** Worlds export while running; Paper plugin versions (EssentialsX); CurseForge ZIP date; Metrics
   disk/TPS formatting; backup schedule rollback (read-only data root).
10. **Errors (F-19):** trigger conflict/validation/not-found and inspect toast code/message handling.
11. **First-run (F-04/F-23):** empty data root → Create forced; Back no-op; catalogue retry.
12. **A11y (F-22):** keyboard tab pass on header + Create modal; Esc close; focus trap.

## Open questions

- Is the `Content` tab now authoritative (port-plan wave) and should `app-tabs.md` become 8 tabs, or is Content a
  deferred/global view? The spec remains 7 tabs and lists "mods browser deferred".
- Which installer-report contract is authoritative: the reduced TS `{status,stages,files,…}` (then the report UI
  needs redesign) or the Rust `InstallReport` (`schemaVersion,planId,serverId,createdAt,sourcePin,loader,…`)?
  The F-01 fix depends on this.
- Should `settingsUpdate` accept `eulaAccepted` on every save (backend stops the server), or should the renderer
  send it only on change? Ownership of the fix needs a decision.
- Is `java_validate` expected to validate an arbitrary user path (spawn `-version`), or only to select from the
  discovered list? The Create/Settings "Change…" copy implies arbitrary paths.
- Modrinth optional files: spec says keep-by-default; TS pipeline says user-choice. Which is intended?
- Is the framework-neutral HTTP export still in scope for the new tabs? If yes, extend the contract and the
  browser mock/upload story; if no, remove/mark dormant the dead HTTP surface like `src-tauri/`.
