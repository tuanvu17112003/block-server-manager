# Backend core & runtime audit

Read-only audit (task-1) of `electron/main.ts`, `preload.ts`, `ipc.ts`, `services/{store,runtime,server-process,jobs,versions,paths}.ts`, `electron/tsconfig.json`, `package.json`, and the uncommitted wave touching these files (`git status` shows them modified; baseline commit `e3d0dbd`). Rust reference (`src-tauri/src/**`, dormant) and `docs/specs/*`, `docs/implementation/*` are treated as the spec where they state binding behavior. No build/dev/electron gate was executed by this auditor; OS-level claims that need a live process are marked **needs runtime check**. Cross-referenced renderer call sites in `src/tauri.ts`, `src/store.tsx`, `src/tabs/Create.tsx`, `src/tabs/Settings.tsx` (UI itself owned by task-2).

## Executive summary

- **Paper server creation is completely missing** in the TS installer (`installLoader` has no `paper` branch) while the Create UI offers Paper and the renderer lists Paper versions. 1 of 5 document-supported loaders cannot be created, and no gate exercises it.
- **Quitting the app does not stop running servers**: `before-quit` fires `void shutdown()` and Electron continues quitting immediately; java children are left running untracked (Rust did a blocking 3 s stop-all + `taskkill /T /F`).
- **The lifecycle state machine is not safe**: no start reservation (duplicate children possible), `server_kill` reports `crashed`, crash-retry loses the log tail it needs (`r` is always `undefined`), and stop-during-boot / restart can race an in-flight retry loop.
- **The JSON store can silently lose data**: a corrupt/unreadable `app-data.json` becomes an empty store and the next write wipes it, and `pushCommand()` saves a stale in-memory snapshot (can delete servers created since the last reload).
- **IPC/Java contracts diverge from the renderer**: `java_detect`/`java_validate` return `javapath`/no `architectureBits` while `JavaCandidate` requires `path`, so Java path display and the manual override flow are broken; NeoForge 1.20.2–1.21.x is never offered (wrong prefix) and modern NeoForge install URLs are wrong.
- **Migration gaps**: no Tauri/SQLite → Electron JSON migration, no JVM identity marker (`-Dtestmultiai.server.id`), orphan reaping trusts only `tasklist` image name, and the "gates" (`--selftest/--e2e`) write the real dev data root and can silently pass.

## Findings

### P0 — critical

### B-01 · Paper server installation is unimplemented · P0 · confirmed
- **Evidence**: `electron/services/installer/core.ts:227-278` — `installLoader` branches only `vanilla`, `fabric|quilt`, `forge`, `neoforge`, then `throw new Error(\`loader not supported: ${kind}\`)` at `:277`; `electron/services/runtime.ts:91,102` maps `Paper → 'paper'` and calls `installLoader('paper', …)`; `electron/services/versions.ts:29` advertises Paper; `src/tabs/Create.tsx:1463` shows the Paper card; `electron/e2e.ts:35-72` never tests Paper.
- **Symptom**: Create → Paper → Install fails with "loader not supported: paper"; server row is rolled back (runtime.ts:112-114) and no server is created.
- **Root cause**: the P1 TS port of the installer omitted the Paper branch that exists in Rust (Fill v3 build resolution on `fill.papermc.io` with `server:default` size+SHA-256 verification: `src-tauri/src/installer/mod.rs:29,2326-2395`).
- **Impact**: a whole documented provider is unusable; the "P3 complete / E2E PASS" claim is blind to it.
- **Recommended fix**: add a `paper` branch: resolve MC build via `https://fill.papermc.io/v3/projects/paper/versions/{v}/builds`, download the artifact-complete `server:default` build, verify size/SHA-256, write `server.jar`; add Paper to E2E.
- **Verification**: renderer console `await window.electronAPI.invoke('server_install',{input:{name:'p',loader:'Paper',mcVersion:'1.21.1',ramMb:1024,eulaAccepted:true},jobId:'j'})` should create + start a Paper server.

### B-02 · Quit while servers run orphans java children (no graceful stop, no tree kill) · P0 · confirmed (code) / needs runtime check (process survival)
- **Evidence**: `electron/main.ts:119-121` wires `app.on('before-quit', () => { void appRuntime.shutdown(); })` and returns immediately; `electron/services/runtime.ts:158-162` shutdown awaits `processes.stopAll()`; `electron/services/server-process.ts:279-281` stopAll → `stop()` waits for `exit` (up to 30 s). Rust did the opposite: synchronous `stop_all_blocking` with `EXIT_STOP_BUDGET=3s` + `taskkill /T /F` (`src-tauri/src/servers/process.rs:1559-1612`).
- **Symptom**: closing the window during/after a server run leaves the `java` process alive; the app exits before `stop` finishes, console log stream/pid file/status cleanup never runs; on next launch `reapOrphans` kills the process mid-write.
- **Root cause**: Electron's `before-quit` is synchronous; the promise is discarded (`void`). No `preventDefault()` + quit-after-cleanup flow.
- **Impact**: unsaved world data / corrupted chunks; a server the user believes closed keeps running with no UI; stale `.msm-server.pid` and `status` rows.
- **Recommended fix**: `before-quit` handler with `event.preventDefault()`, abort-flag, await a bounded shutdown (`stdin stop`, 3-5 s budget, then `taskkill /T /F`), then `app.quit()`; show a "stopping servers…" state.
- **Verification**: start a server, close window, `Start-Sleep 3; Get-Process java` → expect none; check `.msm-server.pid` removed and store status `stopped`.

### P1 — high

### B-03 · Duplicate-start race: no start reservation; two children can spawn for one server · P1 · confirmed (code)
- **Evidence**: `electron/services/server-process.ts:91` checks `this.running.has(id)`, then awaits at `:100` (`freePort`), `:104` (`resolveJava`), `:114` (`applyJarSideness`) before `spawnWatch` inserts the map entry at `:188`. Rust reserved the id before any work and re-checked after spawn (`src-tauri/src/servers/process.rs:164-193,503-512,648-666`); acceptance is explicit: "concurrent starts for one server create at most one child" (`docs/implementation/backend-plan.md:48`, `docs/implementation/checklist.md:17`).
- **Symptom**: two concurrent `server_start` IPC calls (double restart/start, scripted IPC) both pass the guard and spawn java; the second overwrites the first `Running` entry → the first child is untracked and never stopped; both point at the same `servers/<id>` world dir.
- **Root cause**: membership check and registration are separated by async work; there is no in-flight/"reserved" set.
- **Impact**: duplicate child processes, port fights, `session.lock`/world corruption, leaked process on quit, misleading status.
- **Recommended fix**: add a `pending`/reservation set (or a per-id promise mutex) checked-and-inserted synchronously before the first await, released on every exit path; keep the post-spawn duplicate check.
- **Verification**: `Promise.allSettled([invoke('server_start',{id}), invoke('server_start',{id})])` on one stopped server; `Get-Process java` should show exactly one child and no second pid in `.msm-server.pid`.

### B-04 · Crash-retry (L3) loses the log tail it needs, and emits a `crashed` event on every retry round · P1 · confirmed
- **Evidence**: `electron/services/server-process.ts:124-127` reads `const r = this.running.get(id); const tail = r?.ring.slice(-400) ?? []`, but the `exit` handler deletes the entry before resolving `started` (`:221 then :225`), so `r` is always `undefined` and `analyzeFailure([])` can never attribute a mod from console output. Each failed round calls `setStatus(id,'crashed')` (`:224`) then `starting` again (`:164`), so the renderer shows a crash toast per round (`src/store.tsx:449-453`).
- **Symptom**: auto-fix only reacts to `crash-reports/*.txt`; console-detected failures ("Mod X has failed to load correctly", missing dependency lines, mixin frames) are ignored; UI flashes "Server crashed" 1-8 times while the launcher is still auto-fixing.
- **Root cause**: circular ownership bug introduced by the `started`/`exited` split (the ring is dropped with the map entry before the retry code reads it).
- **Impact**: auto-fix underperforms its design; noisy false crash alerts; persisted status flaps.
- **Recommended fix**: capture the ring/pids before `running.delete` or return the ring from `watch.exited`; suppress renderer-visible `crashed` until the final round fails (internal "boot retry" state).
- **Verification**: install a mod with a hard-missing dependency, start it; console log should show `[autofix r…]` from the console matcher and only one final `crashed` status event.

### B-05 · `server_kill` reports `crashed` (and shows a crash toast), Rust reported `stopped` · P1 · confirmed
- **Evidence**: `electron/services/server-process.ts:248-251` `kill()` sends `SIGKILL` without setting user-intent; `userStop` is only set by the 500 ms `stopProbe` on status `stopping` (`:229-234`); the exit handler computes `userStop || (sawDone && code === 0)` (`:224`) → killed process has non-zero/null code ⇒ `crashed`; renderer pushes a crash toast (`src/store.tsx:449-453`). Rust set `live.stopping = true` before force-kill (`src-tauri/src/servers/process.rs:1466-1479`).
- **Symptom**: user clicks Kill/force-stop; UI toasts "Server … crashed" and persists `crashed`.
- **Root cause**: kill path does not mark user intent / `stopping` state.
- **Impact**: wrong status, wrong UX, crash analytics polluted; `status()`/store disagree with user action.
- **Recommended fix**: set `stopping`/user-stop flag before killing (and set status `stopped` at exit when the stop was user-initiated); consider emitting `stopping` first.
- **Verification**: start vanilla, invoke `server_kill`, read `servers_list` → expect `stopped`, no crash toast.

### B-06 · `Store.pushCommand()` saves a stale snapshot and can delete servers/backups created meanwhile · P1 · confirmed
- **Evidence**: `electron/services/store.ts:247-251` — unlike every other mutator it never calls `this.reload()`; it pushes onto the cached `this.data` and `save()`s the whole file. `ServerProcesses` owns one long-lived Store (`electron/services/runtime.ts:52`), and `sendCommand` calls `pushCommand` (`server-process.ts:262-265`).
- **Symptom**: while a server is running, create server B / add a backup / change a setting, then type any console command → `app-data.json` is rewritten from the old snapshot and server B (or the backup record/setting) disappears.
- **Root cause**: missing read-through in `pushCommand` (the P3 "read-through store" fix missed this method).
- **Impact**: silent loss of user records/settings; UI appears to lose new servers after console use.
- **Recommended fix**: `this.reload()` at method start (or a single `mutate(fn)` helper doing reload→fn→save); add a store test that interleaves two Store instances.
- **Verification**: start server; `invoke('servers_create')` a second server; `invoke('server_send_command',{id:running,cmd:'list'})`; re-read `app-data.json` — second server must still exist.

### B-07 · Corrupt/unreadable store is silently replaced by an empty store, then overwritten · P1 · confirmed
- **Evidence**: `electron/services/store.ts:99-116` — any `readFileSync`/`JSON.parse`/shape error is swallowed and `this.data = emptyData()`; the next `save()` (`:118-122`, `writeFileSync(tmp)+renameSync`) destroys the previous file. Rust kept SQLite transactions/cascade (`src-tauri/src/db/mod.rs`); no backup/`.bak`, no schema validation.
- **Symptom**: a torn write, AV lock, permission error or manual edit makes every server vanish; one subsequent create/delete/status write permanently erases the file.
- **Root cause**: catch-all error handling conflates "first run / missing file" (`ENOENT`) with "file exists but unreadable/corrupt"; no quarantine.
- **Impact**: irreversible loss of the whole server registry + settings + backups index + command history.
- **Recommended fix**: only treat `ENOENT` as empty; on parse/read failure throw a loud error (UI banner, retain file), or copy to `app-data.json.corrupt-<ts>` before recovery; fsync/`.tmp` unique per write.
- **Verification**: back up `.app-data/app-data.json`, write `{invalid`, launch, open app → expect error state/no wipe; then restore.

### B-08 · Java DTO contract mismatch (`javapath` vs `path`, missing `architectureBits`) breaks display + manual override · P1 · confirmed
- **Evidence**: `electron/services/runtime.ts:55-59` (`java_detect` returns `found` = `{major, javapath, source}`) and `:61-68` (`java_validate` returns the same `hit`); `electron/services/installer/core.ts:166-191` (`JavaRuntime` interface, `javapath`); renderer expects `JavaCandidate {path, major, architectureBits, source}` (`src/tauri.ts:225-230`) and reads `candidate.path` (`src/tabs/Create.tsx:813-816,1229,2300,2333`; `src/tabs/Settings.tsx:204-208`). `java_ensure` instead returns `path` with hard-coded `architectureBits: 64` (`runtime.ts:69-76`).
- **Symptom**: diagnose panel shows "Java 21 · installed" with a blank path; Create passes `javaPath: undefined`; manual override validate sets an object whose `.path` is `undefined`, so the install guard (`javaOverride && javaSelected.path !== javaPath.trim()`, `Create.tsx:1203-1205`) permanently blocks Install with "Select or install a compatible Java runtime first." Settings "save override" persists `null` while toasting success.
- **Root cause**: TS installer engine DTO (`javapath`) was wired into the Rust-shaped renderer contract without a mapper; no typecheck across the untyped handler boundary.
- **Impact**: Java override flow is unusable; Java path never persists from detect/validate; per-server Java settings silently cleared.
- **Recommended fix**: map to `{path: javapath, major, architectureBits, source}` in both handlers (or use a shared `JavaCandidate` type); add an ipctest assertion on the exact field names.
- **Verification**: `java_detect` on 1.21.1 → `candidates[0].path` defined; UI → Settings → Change → enter a valid `java.exe` → override accepted and `servers_list[].javaPath` updated after save.

### B-09 · `server_install` creates the record before validation and leaves a partial server directory on failure/cancel · P1 · confirmed
- **Evidence**: `electron/services/runtime.ts:87-118` — `s.createServer(...)` at `:92` (record visible in `servers_list` immediately), install at `:102`, catch only `s.deleteServer(dto.id)` at `:112-114`, never `fs.rmSync(servers/<id>)`; `installLoader` does `mkdirSync(dir)` first (`core.ts:228`). Spec: publish only after validation and "failure or cancellation leaves no persistent server record or partial server directory" (`docs/specs/server-installs.md:27-36,61`; `docs/implementation/phase4-server-installs.md:19`). The separate pipeline path already does rollback (`electron/services/pipeline.ts:193-200`).
- **Symptom**: a failed install leaves `servers/<uuid>/` (mods/cache/libraries) forever; during a multi-minute install the server is listed with status `stopped` although it cannot start; no `installer.log` is kept for Retry (`docs/specs/server-installs.md:31`).
- **Root cause**: only the pipeline got the staging/rollback treatment; the `server_install` ↔ `tauriInstall.install` path (Create wizard for Vanilla/Paper/Fabric/Forge/NeoForge) is still the P1 implementation.
- **Impact**: disk litter, confusing list entries, broken crash-window recovery, missing diagnostics.
- **Recommended fix**: install into a staging dir, verify artifacts/launch shape, then publish; on any error `rm -rf` the dir; record installer output to `<dir>/installer.log`.
- **Verification**: `server_install` with loader Forge, mcVersion 1.20.1, loaderVersion `9.9.9` → rejection and no `servers/<id>` dir, no row.

### B-10 · Spawn failure has no `error` listener: unhandled exception and a never-settling start promise · P1 · confirmed (code) / needs runtime check (app crash vs hang)
- **Evidence**: `electron/services/server-process.ts:172` `spawn(...)` with no `proc.on('error', …)` anywhere in `electron/` (grep); `started`/`exited` promises are only resolved by `exit` (`:220-227`), and `start()` awaits `started` (`:119`). A configured java path is accepted unvalidated by `servers_set_java_path` (`electron/ipc.ts:47`) and used verbatim (`runtime.ts:46-48`).
- **Symptom**: a stale/invalid/moved `javaPath` (or deleted JDK) makes `spawn` emit `error`; with no listener this becomes an uncaught main-process exception (app crash/error dialog), and the IPC promise never rejects so the renderer start spinner/toast never resolves.
- **Root cause**: only the happy path of `ChildProcess` is wired; Rust converted spawn failure into `AppError::Io` with cleanup (`src-tauri/src/servers/process.rs:628-646`).
- **Impact**: crash or hang on a common misconfiguration; no actionable error to the user.
- **Recommended fix**: `proc.on('error', err => { setStatus crashed; resolveStarted('crashed'); resolveExited(); send log/error })`; validate `.exe` existence/type before spawn.
- **Verification**: point `servers_set_java_path` at `C:\nope\java.exe`, start → a toastable `io`/`validation` error, app stays alive.

### B-11 · NeoForge resolution/install mapping is broken for modern versions · P1 · confirmed (code + live metadata)
- **Evidence**: `electron/services/versions.ts:45-48` builds `prefix = mcVersion.split('.').slice(0,2).join('.') + '.'` (e.g. `1.21.`) and filters NeoForge Maven versions; live `net/neoforged/neoforge/maven-metadata.xml` versions for MC 1.21.1 are `21.1.x` (`21.1.253`–`21.1.265`) — none start with `1.21.`, so no NeoForge choice appears for 1.20.2–1.21.x. `electron/services/installer/core.ts:258-275` then builds the installer coordinate as `${mc}-${bare}` — again wrong for modern NeoForge (`net/neoforged/neoforge/21.1.66/neoforge-21.1.66-installer.jar` has no MC prefix), while the Rust mapping is documented and unit-tested.
- **Symptom**: Create → NeoForge unavailable for the most-used MC versions (only legacy 1.20.1 path via `net/neoforged/forge`); if a modern version is ever returned, install 404s.
- **Root cause**: simplified provider resolution in the port; the documented MC↔NeoForge scheme table (Rust `neoforge_prefix`) was not carried over, and `installLoader` still assumes the legacy `${mc}-${ver}` coordinate.
- **Impact**: one of five loaders effectively missing/incorrect; stale-UI installs fail late.
- **Recommended fix**: port the documented prefix table (1.20.1→`1.20.1-`, 1.20.2+→major.minor family e.g. `21.1.`) and build modern URLs from the mapped family; label betas and sort stable first.
- **Verification**: `loaders_resolve` for 1.21.1 must contain a NeoForge entry; install it (or at least HEAD the constructed URL).

### B-12 · Version/loader catalogue regressions vs the accepted spec (Vanilla types, Paper types, single-choice loaders) · P1 · confirmed
- **Evidence**: `electron/services/versions.ts:7-13` returns every Mojang manifest entry including `snapshot`, `old_alpha`, `old_beta`; spec says release-only by default and never `old_*` (`docs/specs/server-installs.md:10-22`, `docs/implementation/new-server-improvements.md:10`). `versions.ts:15-23` maps Paper `version.support.status !== 'SUPPORTED'` to `versionType:'snapshot'` and returns `releaseTime:''`; live Fill v3 says 1.21.1 is `UNSUPPORTED` yet has 100+ builds, so the Create picker's release filter hides Paper 1.21.x. `loadersResolve` offers at most one Fabric loader (`:31-32`: `fabric[0]`), only Forge `recommended|latest` promo (`:35-37`), one NeoForge match (`:45-48`), and Paper unconditionally (`:29`) — ADR-0007 / `docs/implementation/full-version-catalogue.md:19-28` require the full provider catalogues with stability labels.
- **Symptom**: ancient alphas/betas appear behind "Show snapshots" (and fail with "no server download"); Paper versions are mislabelled as snapshots; users cannot pick a specific Fabric/Forge/NeoForge loader build and Paper is offered for versions with no builds.
- **Root cause**: provider resolvers were simplified during the port instead of ported from Rust `installer::resolve_vanilla_versions` / `resolve_loader_choices`.
- **Impact**: version picker factually wrong; compatibility claims unreliable; stale selections fail at install time.
- **Recommended fix**: filter Vanilla to `release` (+ explicit snapshot opt-in), map Paper channels properly and derive availability from `/builds`, port the full Fabric/Forge/NeoForge catalogues with `stable` flags/labels per ADR-0007.
- **Verification**: `versions_vanilla` has no `old_*`/snapshots by default call; `versions_paper` for 1.21.1 has `versionType:'release'`; `loaders_resolve('1.21.1')` returns ≥2 Fabric and multiple Forge/NeoForge options.

### B-13 · No migration of Tauri/SQLite data to the Electron JSON store/data root · P1 · confirmed
- **Evidence**: `electron/services/paths.ts:8-15` only resolves `userData/data` (prod) or `<project>/.app-data` (dev); `electron/services/store.ts:88-95` reads only `<dataRoot>/app-data.json`; grep for `app.db|sqlite|migrat|schema migration` in `electron/` finds nothing. Rust layout: `<app-data>/app.db` + `<app-data>/servers/<id>` (`src-tauri/src/util/paths.rs:12-43`, `src-tauri/src/db/mod.rs:18-108`); Tauri identifier `com.blockserver.manager` (`src-tauri/tauri.conf.json`) vs Electron `name: mc-server-manager` (`package.json`) ⇒ different `%APPDATA%` directories.
- **Symptom**: an existing Tauri user launching the Electron build sees an empty server list; all `app.db` rows/settings/command history are ignored and the per-server folders become unreachable orphans (Electron never reaps dirs without records).
- **Root cause**: the port plan chose a JSON store (`docs/electron-port-plan.md:7,17`) but no one-time import was specified/implemented.
- **Impact**: full data loss for existing installs; if this build ships as an update, it is a release blocker.
- **Recommended fix**: one-shot migration on first run: locate Tauri `app_data_dir`, import `servers/backups/console_command_history/settings` rows into `app-data.json` (schema v2), copy/reuse `servers/<id>` folders, then write a migration marker; or explicitly drop the Tauri data root in release notes and delete/ignore it.
- **Verification**: point the app at a fixture `%APPDATA%\com.blockserver.manager` (server row + dir), launch, expect the server listed with working start/stop and no duplicate copy.

### B-14 · Orphan reaping trusts only the `java` image name; no identity marker/launch-shape check · P1 · confirmed (code), PID-reuse impact likely
- **Evidence**: `electron/services/server-process.ts:60-84` reads `.msm-server.pid`, does `tasklist /FI "PID eq <pid>"` and kills if `/java/i` matches the image; no command-line/CIM inspection, no per-server marker, and the pid file is deleted even when verification failed (`:79`). Electron never adds the Rust identity marker `-Dtestmultiai.server.id=<id>` (`src-tauri/src/modpacks/pipeline/launch.rs:246-279`; grep: none in `electron/`). Required behavior: exact launch shape + marker + fail-closed CIM (`docs/research/2026-10-08-phase2-process-safety.md:7,15`; `docs/implementation/checklist.md:18`; `docs/specs/server-installs.md:37`). Legacy Rust lockfile is `server.lock`, so pre-existing Tauri orphans are silently ignored (`src-tauri/src/servers/process.rs:1617-1676` vs Electron `.msm-server.pid`).
- **Symptom**: after a Windows PID recycle, Electron can kill an unrelated `java.exe`; conversely it cannot prove ownership, so real orphan servers may be left alive if the pid file was lost; Tauri-era orphans are never reaped.
- **Root cause**: orphan verification was reduced to the cheapest check; the marker was never added to the launch command (also means `has_server_identity`-style checks are impossible).
- **Impact**: kills unrelated workloads (data/security risk); fails the documented fail-closed identity requirement.
- **Recommended fix**: add `-Dtestmultiai.server.id=<uuid>` to every launch arg set (jar and argument-file modes); verify via `Get-CimInstance Win32_Process` CommandLine containing the marker + expected `-jar`/arg-file tokens before killing; honor both `server.lock` (migration) and `.msm-server.pid`; keep pid file when verification fails.
- **Verification**: manually start a vanilla server java process, write its PID into another server's `.msm-server.pid`, launch the app → the unrelated process must survive (fails today); with the fix, only the marker-matching process is killed.

### P2 — medium

### B-15 · Start does not validate configured Java and may hit Mojang/Adoptium on the start path · P2 · confirmed
- **Evidence**: `electron/services/runtime.ts:46-51` — if `dto.javaPath` exists it is returned unvalidated; otherwise `requiredJavaMajor()` fetches piston-meta (`core.ts:148-164`) and `ensureJava()` may download a JDK (`core.ts:192-209`). Spec: Start uses a local mapping, must not wait on Mojang, must validate major/architecture, and if no runtime is set must return a clear error instead of provisioning (`docs/specs/java-provisioning.md:34-38,60`; `docs/implementation/backend-plan.md:52`). `ensureJava` also downloads without Adoptium SHA-256 verification (only `size`, `core.ts:197-200`) though the spec requires it (`docs/specs/java-provisioning.md:56`).
- **Symptom**: offline/slow-network start hangs or silently auto-downloads hundreds of MB; a 32-bit/too-old configured runtime is launched anyway (Minecraft fails opaquely); unverified JDK zip is executed.
- **Root cause**: P1 start implementation reused the Create/provisioning helpers instead of the Rust `resolve_server_java` (local mapping + validation + fail-closed).
- **Impact**: slow/hanging starts, surprising network/disk use in a "start" action, supply-chain exposure.
- **Recommended fix**: use the fixed local Java mapping for Start; validate `dto.javaPath` (exists, `-version` major, 64-bit); fail with a clear error when none exists; keep `java_ensure` for the explicit Install-Temurin action, and verify the Adoptium SHA-256/size.
- **Verification**: disconnect network, start a server whose runtime was previously installed → starts promptly; set a Java 8 path on a 1.21.1 server → rejected with a clear message.

### B-16 · `stop()` can hang forever on an exit/listener race; IPC blocks up to 30 s; no tree kill · P2 · likely
- **Evidence**: `electron/services/server-process.ts:237-246` reads `r`, writes `stop\n`, then registers `r.proc.once('exit', …)` inside the promise; if the process exits between the map lookup and listener registration the event is never re-delivered ⇒ the promise never resolves (the 30 s timer only calls `kill`, which does not resolve). The IPC handler awaits this (`runtime.ts:122`), unlike Rust which returned immediately and used an exit poller (`src-tauri/src/servers/process.rs:1389-1438`). Force kills use `proc.kill('SIGKILL')` (`:250`), not `taskkill /T /F`, so descendants survive (Rust `:1441-1463`; checklist:19).
- **Symptom**: rare but permanent "stopping" hang / never-resolving `server_stop` (and `before-quit` shutdown); orphaned child processes from java-spawned helpers; stop calls block the UI promise for the full graceful window (30 s vs 15 s Rust).
- **Root cause**: listener registration after the state check rather than on spawn; no `exitCode/signalCode` re-check; no process-tree kill.
- **Recommended fix**: if `r.proc.exitCode !== null || r.proc.signalCode !== null` resolve immediately; register a single persistent exit observer at spawn; use `taskkill /T /F` on timeout/kill (Windows) with direct kill fallback.
- **Verification**: loop start/stop 50×; assert every `server_stop` promise settles and no `java` remains (`Get-Process java`).

### B-17 · Stop-during-boot and restart can race the crash-retry loop · P2 · likely
- **Evidence**: `electron/services/server-process.ts:229-234` detects a user stop via a 500 ms poll of `r.status === 'stopping'`; a process that exits within that window yields `userStop=false → resolveStarted('crashed')` (`:225`) and `start()` continues into L3 retry/spawn (`:117-165`) — after the user asked to stop. `restart()` (`:253`) does `stop → sleep 1500 → start`, while the original `start()` retry loop may still be running (no reservation, see B-03), so a second child can be spawned by the retry loop and the restart.
- **Symptom**: Stop during boot occasionally results in "crashed" plus a relaunch; Restart on a starting/crashing server can produce two children or a status flapping between crashed/starting/running.
- **Root cause**: user-intent is inferred from a polling side channel instead of an explicit flag on the `Running` state; lifecycle operations are not serialized.
- **Impact**: user cannot reliably stop a booting server; duplicate processes (see B-03 impact).
- **Recommended fix**: set an explicit `stopping`/`userStop` flag synchronously in `stop()`/`kill()` and short-circuit retry when set; serialize lifecycle ops per id (queue/mutex) and make restart await the in-flight start.
- **Verification**: start a server that fails boot, click Stop immediately, then observe console/pid: exactly one spawn attempt, final status `stopped`.

### B-18 · Console contract regressions: no command validation, no line cap, tail default/cap/ID-validation, history shape/retention/cascade · P2 · confirmed
- **Evidence**: `server-process.ts:262-265` `sendCommand` accepts empty/multi-line commands (Rust `servers/console.rs:28-39` rejects); `:205-217` stores unbounded-length lines in a 5000-entry ring (Rust truncates each line at 4096 bytes and has a byte-level lossy decoder, `src-tauri/src/servers/process.rs:49,720-800`, `docs/specs/console-stream-resilience.md:11`); `runtime.ts:126` `tail(id, Number(a.lines ?? 200))` has Rust defaults 1000/max 10000 but no cap and no `id` validation (path traversal into `path.join(dataRoot,'servers',id,'logs','msm-console.log')`, `server-process.ts:267-277`); `store.ts:247-256` returns `string[]` with 500 global chronological entries, while the spec requires per-server newest-first entries with timestamps capped at 100 (`docs/specs/console-backend.md:11-13`; Rust `console.rs:57-105`); `store.ts:164-171` deletes a server without cascading `consoleCommandHistory`.
- **Symptom**: empty/multi-command sends create bogus history; a mod spamming huge lines can balloon main-process memory and renderer payloads; `logs_tail` on an arbitrary id reads outside the data root; command history loses timestamps/order and grows stale entries for deleted servers.
- **Root cause**: console was ported as a thin adapter over the live ring instead of the documented contract.
- **Recommended fix**: validate `id` (UUID regex) and command (trim, non-empty, single line); cap requested lines (10000) and truncate lines; per-server 100-entry history with timestamps, newest-first; cascade delete; document the `msm-console.log` deviation explicitly or read `logs/latest.log`.
- **Verification**: `server_send_command` with `"\nstop\n"` → validation error; `logs_tail` with `id:'..\\..\\x'` → validation error; delete server and confirm history rows gone.

### B-19 · Console persistence/tail performance: synchronous full-file read on the main process · P2 · confirmed
- **Evidence**: `server-process.ts:271-273` `fs.readFileSync(<logs>/msm-console.log)` (up to 10 MB by the `:178-180` rotation check) on every `logs_tail` call, then `split('\n').filter(...).slice(-lines)`; renderer requests it on every server selection (`src/store.tsx:410`). Rotation only happens at next spawn and renames to `.1` without a bound, and `logs_tail` ignores `.1`.
- **Symptom**: UI freeze/lag when opening Console for a busy modded server; `.1` history never served.
- **Root cause**: simple sync implementation of a spec that explicitly calls for bounded, rotation-tolerant reads (`docs/specs/console-backend.md:11,22`).
- **Recommended fix**: async bounded tail read (read last N chunks from file end), include `.1`, cap total bytes; or keep an in-memory bounded ring persisted asynchronously.
- **Verification**: grow `msm-console.log` to ~10 MB and time `logs_tail`; expect <100 ms and no event-loop stall.

### B-20 · EULA DB/file agreement is lost; stale `eula.txt=false` is ignored and start proceeds · P2 · confirmed
- **Evidence**: `server-process.ts:95-96` only checks the JSON flag then calls `writeEula(dir)`, which writes only when the file is missing (`core.ts:494-498`); an existing `eula.txt` with `eula=false` is left untouched, so Minecraft exits immediately and the auto-fix loop treats it as a mod crash. Rust required both flag and file to agree and refused with `validation` (`src-tauri/src/servers/process.rs:516-531`); binding principle "EULA is NEVER auto-accepted" (`docs/implementation/backend-plan.md:6`).
- **Symptom**: server with DB flag true but file false (manual edit/old data) fails cryptically after boot, possibly retried 8×, instead of "accept EULA".
- **Root cause**: `writeEula` "create-if-missing" semantics used as an acceptance check.
- **Recommended fix**: parse `eula.txt`; if not `eula=true` return `validation` (never overwrite false implicitly); write true only on explicit user acceptance (`properties.ts:203-215` already does this for settings).
- **Verification**: set `eulaAccepted:true` then rewrite `eula.txt` to `eula=false`; start → validation error naming EULA, no java spawn.

### B-21 · Job cancellation is advisory only; AbortController is never used; job-id collisions silently overwrite · P2 · confirmed
- **Evidence**: `electron/services/jobs.ts:11-34` creates an `AbortController` but nothing passes `.signal` (grep: no `signal`/`abort(` consumers); cancel only sets a boolean checked at two checkpoints in `server_install` (`runtime.ts:99,103`) and in the pipeline (`pipeline.ts:126,140,177`). Downloads/installers (`core.ts:27-62,213-226`) have no abort hook, so Cancel cannot interrupt network/`java -jar` work. `begin()` overwrites an existing controller for the same id and `end()` clears the cancelled flag (`jobs.ts:11-15,31-34`); `cancel` before `begin` returns false. `java_ensure` never calls `begin`, so its job can never be cancelled.
- **Symptom**: Cancel during a large download waits for the download/installer to finish; a cancel race can still complete an install (`status:'complete'`) after the UI showed "cancelled"; duplicate job ids corrupt each other's state.
- **Root cause**: AbortController is decorative; only cooperative flags are wired and only at coarse boundaries.
- **Recommended fix**: thread `AbortSignal` through `fetchOk`/`download`/`runInstaller` (kill child on abort); register jobs at command start (including `java_ensure`); reject `begin` on duplicate id; make cancel sticky until `end`.
- **Verification**: start a large (`~300 MB`) install, Cancel mid-download → bytes stop within ~1 s, no record/dir, `job://progress` final state `cancelled`.

### B-22 · Port model regression: no allocation/uniqueness; servers default to 25565; start silently rewrites the port · P2 · confirmed
- **Evidence**: `electron/services/store.ts:134-162` `createServer` uses `input.port > 0 ? input.port : 25565` with no validation or cross-server uniqueness (Rust allocated `next_free_port`/`claim_port` from DB+OS, `src-tauri/src/util/ports.rs:33-63`, schema `port INTEGER NOT NULL UNIQUE`, `db/mod.rs:28`); `server-process.ts:97-103` silently picks a different free port at start and rewrites `server.properties` + the DTO. `freePort` increments unbounded (`core.ts:318-328`) — above 65535 it throws a `RangeError` instead of a conflict error.
- **Symptom**: multiple servers show port 25565 simultaneously; the port the user configured changes after Start without confirmation; UI port-conflict hint is unreliable.
- **Root cause**: the SQLite allocator/unique constraint was dropped with the DB without a JSON replacement.
- **Impact**: user confusion, saved port != running port, fragile external port-forwarding setups.
- **Recommended fix**: add a `Store.allocatePort(preferred?)` that checks other records + live processes; validate 1024-65535; create should reject duplicates; document the start-reconciliation behavior (or make it explicit/confirmable).
- **Verification**: create 2 servers without port → distinct ports; start both → ports unchanged; `port_check` matches.

### B-23 · `servers_create` and `servers_set_java_path` lost their validation/stopped guards · P2 · confirmed
- **Evidence**: `electron/ipc.ts:33` and `store.ts:134-162` only check duplicate names — no name length/newline/`=` guard, loader allowlist, `mcVersion` check, RAM bounds, Java validation, or directory scaffold (Rust `src-tauri/src/servers/mod.rs:104-212`); `electron/ipc.ts:47` writes any `path` (or null) with no validation and no liveness/stopped check (Rust `src-tauri/src/cmds/servers.rs:37-62` uses `validate_java_for_version` + `with_server_stopped`).
- **Symptom**: `servers_create` can persist malformed/unsupported rows (bad loader, 1 MB RAM, name with newlines) that later fail opaquely; Java path can be changed on a running server (next restart uses unvalidated exe).
- **Root cause**: P0 store implementation kept as final for shell commands.
- **Impact**: invalid state via IPC, UI/back-end divergence, harder to reason about install safety.
- **Recommended fix**: port the Rust validation table into `store.createServer`/IPC and validate Java override through `java_validate`; gate java-path writes on `processes.isBusy(id)`.
- **Verification**: `servers_create` with `ramMb:1, loader:'Quilt'` → validation errors; set java path while running → conflict.

### B-24 · Renderer hardening gaps: no CSP, no navigation/window-open controls, unvalidated `openExternal`, unused bridge surface · P2 · confirmed
- **Evidence**: `electron/main.ts:10-31` sets `sandbox/contextIsolation/nodeIntegration` correctly but no `session` CSP header, no `setWindowOpenHandler`, no `will-navigate` guard; `index.html:1-11`/`dist/index.html` have no CSP meta; `ipc.ts:81` `shell:open-external` calls `shell.openExternal(String(args))` with no scheme allowlist (exposed via `preload.ts:32`); `preload.ts:30-32` also exposes unused `pickMrpack/pickZip` (no renderer callers); dialog handlers bypass the `{__ipc}` error envelope (`ipc.ts:109-114`), so they reject with Electron's prefixed message; `ipcMain.handle` does not validate `event.senderFrame` origin.
- **Symptom**: a renderer XSS or malicious page load can navigate the app window, `window.open` new unmanaged windows, or open arbitrary URI schemes (e.g. `file://`, `smb://`) via the bridge; external EULA/CurseForge links open inside Electron windows instead of the default browser because `window.open` is not handled.
- **Root cause**: security hardening called out as "Phase 10" in the Rust plan was not ported with the shell.
- **Impact**: defense-in-depth gap for a local app that can download/execute files; broken external-link UX.
- **Recommended fix**: attach a strict CSP (`default-src 'self'`; no `unsafe-eval`), `setWindowOpenHandler` → `shell.openExternal` only for `https:` allowlist, `will-navigate` deny, sender-frame checks in `registerIpc`, wrap dialogs in the same envelope, remove unused preload APIs.
- **Verification**: click the EULA link → opens system browser (not an Electron window); DevTools `window.electronAPI.openExternal('file:///C:/Windows/win.ini')` → rejected.

### B-25 · Gate integrity: `--selftest` tests only phase-0 handlers and cannot fail on strings; gate modes use the real dev data root and can silently pass · P2 · confirmed
- **Evidence**: `electron/main.ts:73-79` runs `runSelfTest(ctx)` without `wireIpc`, so runtime handlers are absent (comment `ipc.ts:38-40` acknowledges this); the verdict is `results.every(r => r.v === true || typeof r.v === 'string')` (`ipc.ts:141`), so `'wrong'`/`'no-error'` strings always pass; `ctx.dataRoot = dataRoot()` (`main.ts:61`) is the real `.app-data` (selftest creates/deletes a real record); `--e2e` also uses the real `.app-data` and purges `e2e-*` records (`e2e.ts:16-30`) without isolating or shutting down the runtime (`main.ts:81-86`); `--ipctest` copies `ipc-result.txt`/`ui-smoke.png` into the real data root (`main.ts:110-113`); when another instance holds the single-instance lock, `app.quit()` at `main.ts:51-53` exits 0 before any test runs (silent false PASS); test harnesses are compiled into the production bundle (`electron/tsconfig.json:16`).
- **Symptom**: "SELFTEST PASS" says nothing about runtime; `npm run selftest` during a running dev app returns exit 0 with no output; gates mutate the user's/dev data dir, can interfere with each other, and are not parallel-safe.
- **Root cause**: test modes predate the runtime and were not migrated to temp roots/shared assertions.
- **Impact**: false-green gates; hidden regressions (e.g. Paper, kill semantics, duplicate start are untested); dangerous CLI affordances in the shipped main bundle.
- **Recommended fix**: selftest should wire the runtime and use a temp root; make verdicts boolean-only; `--e2e`/`--ipctest` should use temp roots (copy artifacts explicitly); ensure locked-instance test launches fail loudly (exit 2); exclude `e2e/ipc-test/mgmt-test` from packaged builds or gate them behind `app.isPackaged`.
- **Verification**: run `npm run selftest` with an Electron app already open → must not exit 0 silently; delete the string-tolerant check and verify a deliberately broken assertion fails.

### P3 — low

### B-26 · Rust structured logging/crash diagnostics were not ported · P3 · confirmed
- **Evidence**: grep in `electron/` finds only `console.log` (e.g. `core.ts:14`, `server-process.ts:72,157,160`); Rust had file logging with daily rotation (`src-tauri/src/util/logging.rs`, `src-tauri/src/lib.rs:52`) and failure evidence collectors (`src-tauri/src/servers/process.rs:805-1250`). `--e2e` also relies on `console.log`+`app.exit` (`e2e.ts:109-113`).
- **Symptom**: packaged app (no attached console) has no persistent diagnostics; installer/auto-fix history is lost between runs; support reports cannot be reconstructed.
- **Recommended fix**: add `<dataRoot>/logs/launcher.log` rotating logger, route `log()` and lifecycle transitions there; keep stderr mirror in dev.
- **Verification**: packaged run produces log lines for start/stop/install with timestamps; file rotates.

### B-27 · Error-code/status semantics drift across commands and persisted status · P3 · confirmed
- **Evidence**: `server-process.ts:248-262` kill/stop/sendCommand on a non-tracked server return silently or throw `conflict`; Rust returned `not-found`/`not-found` respectively (`src-tauri/src/servers/process.rs:1392,1466,1483`); `logs_tail`/`server_command_history` do not check the server exists (`runtime.ts:126-127`) while Rust returns not-found (`src-tauri/src/cmds/console.rs:17-20,36`); `status()` returns `'stopped'` for crashed servers (`server-process.ts:40`) while the store/event say `crashed`; `ipc.ts:34-46` guards delete on the persisted `status` string instead of the live registry (Rust checks `ProcessState`, `src-tauri/src/cmds/servers.rs:72-82`).
- **Symptom**: UI toasts differ by operation (silent success vs error), internal status queries disagree with events, delete guard can be bypassed by status drift.
- **Recommended fix**: normalize error codes to the Rust set (`validation/not-found/conflict/io/internal`), add existence checks, derive delete/stop guards from `processes.isBusy(id)`/`status(id)`, consider `status()` returning `crashed` when untracked-but-persisted-crashed.
- **Verification**: each lifecycle command against a missing/stopped id returns `not-found`/`conflict` consistently with `src/tauri.ts` AppError handling.

### B-28 · Store durability/robustness details: no fsync, fixed `.tmp`, no per-row validation, no history cascade · P3 · confirmed
- **Evidence**: `store.ts:118-122` writes `app-data.json.tmp` then renames (good atomicity) but no `fsync`/backup and the same tmp path for every writer; `reload` accepts any array shapes (`:99-116`) and `servers_list` later does `path.join(..., dto.id)` (`ipc.ts:21-23`), so one malformed row can make the entire list handler throw; `deleteServer` (`:164-171`) does not filter `consoleCommandHistory`; `schemaVersion` is forced to 2 without migrations.
- **Impact**: partial hardening vs SQLite; a single bad row breaks the whole list; deleted servers keep history.
- **Recommended fix**: validate/normalize rows on load (drop/quarantine invalid, log); delete command history with the server; write `app-data.json.bak` before rename; unique tmp suffix.
- **Verification**: inject a row missing `id` → list still loads (row quarantined); delete a server → its history entries gone.

### B-29 · Stale comments/dead code and unused bridge surface · P3 · confirmed
- **Evidence**: `electron/ipc.ts:56-67` still claims the 14 implemented commands "arrive in the next port phase" (all are overridden, verified: pipeline.ts:209-219, staging:79-91); `ipc.ts:144` `void appError;`; `store.ts:1-2` says the JSON store "mirrors the Rust SQLite rows"; `server-process.ts:23` `stopTimer?` field never used; `preload.ts:30-32` exposes unused pickers/`openExternal`; `jobs.ts:1` claims AbortController wiring that does not exist. Port plan (`docs/electron-port-plan.md:30`) also promises "event channels identical to Rust", but `server://readiness/{id}` (`src-tauri/src/servers/process.rs:99-101`) is never emitted and their consumers do not exist yet.
- **Impact**: misleading maintainers about implemented behavior; small dead attack surface.
- **Recommended fix**: delete placeholders/stale comments or replace with accurate status; remove unused preload APIs or document them as future; decide/readiness events explicitly.
- **Verification**: grep/tsc clean; code review of the port-plan claims.

## Incomplete-migration inventory (runtime/store scope)

| Rust behavior (reference) | Electron status | Evidence |
|---|---|---|
| SQLite `app.db` + additive migrations | **Missing** — JSON `app-data.json`, no migration from DB | `src-tauri/src/db/mod.rs:18-108`; `electron/services/store.ts:88-122` |
| Tauri `app_data_dir` layout reused | **Missing** — different dirs (`com.blockserver.manager` vs `mc-server-manager`) | `src-tauri/src/util/paths.rs:12-43`; `electron/services/paths.ts:8-15` |
| `servers_create` validation + folder scaffold + Java validation | **Missing/partial** (dup name only) | `src-tauri/src/servers/mod.rs:104-212`; `electron/services/store.ts:134-162` |
| Port auto-allocation + DB uniqueness + claim validation | **Missing** (default 25565, no uniqueness) | `src-tauri/src/util/ports.rs:33-63`; `electron/services/store.ts:146` |
| Serialized start reservation; ≤1 child | **Missing** (race) | `src-tauri/src/servers/process.rs:164-193,503-512`; `electron/services/server-process.ts:91,100-118` |
| PID lockfile write failure ⇒ kill child + error | **Partial** (best-effort `.msm-server.pid`) | `src-tauri/src/servers/process.rs:636-646`; `electron/services/server-process.ts:185-187` |
| JVM identity marker `-Dtestmultiai.server.id` | **Missing** | `src-tauri/src/modpacks/pipeline/launch.rs:246-279`; grep none in `electron/` |
| Orphan reap: image + launch shape + marker, fail-closed CIM | **Partial** (java image only; deletes pid file unverified) | `src-tauri/src/servers/process.rs:1617-1807`; `electron/services/server-process.ts:60-84` |
| Legacy `server.lock` migration | **Missing** | `src-tauri/src/servers/process.rs:1617-1676`; Electron uses `.msm-server.pid` only |
| Readiness tracker + `server://readiness/{id}` events | **Missing** (Done regex + 10-min watchdog only) | `src-tauri/src/servers/process.rs:99-101,683-708`; `electron/services/server-process.ts:197-235` |
| `running` promotion after 1 s grace / fast `server_start` return | **Changed** — start awaits `Done(` (up to 10 min), otherwise fails | `src-tauri/src/servers/process.rs:1305-1310,503-512`; `electron/services/server-process.ts:117-120` |
| Graceful stop 15 s + `taskkill /T /F`; `server_stop` returns fast | **Partial** — 30 s then direct SIGKILL, IPC blocks until exit | `src-tauri/src/servers/process.rs:1389-1463`; `electron/services/server-process.ts:237-251` |
| Blocking stop-all on window close (3 s + tree kill) | **Missing** (async void) | `src-tauri/src/servers/process.rs:1559-1612`; `electron/main.ts:121` |
| Kill sets user-stop intent ⇒ final `stopped` | **Missing** (reports `crashed`) | `src-tauri/src/servers/process.rs:1466-1479`; `electron/services/server-process.ts:224,248-251` |
| Restart sequencer waits for exit + supersede handling | **Partial** — sleep 1500 + start; races retry loop | `src-tauri/src/servers/process.rs:1510-1555`; `electron/services/server-process.ts:253` |
| Console: single-line command validation | **Missing** | `src-tauri/src/servers/console.rs:28-39`; `electron/services/server-process.ts:262-265` |
| Command history per-server 100 entries, timestamps, newest-first, cascade delete | **Changed** — `string[]`, 500 global, chronological, no cascade | `src-tauri/src/servers/console.rs:57-105`; `electron/services/store.ts:247-256,164-171` |
| `logs_tail` native `logs/latest.log`, canonical containment, default 1000/max 10000 | **Changed** — own `msm-console.log`, sync read, default 200, no cap/ID validation | `src-tauri/src/servers/console.rs:41-55,107+`; `electron/services/server-process.ts:267-277`; `runtime.ts:126` |
| Console byte-level lossy decode + 4096-byte line cap | **Partial** (`Buffer.toString`, no cap) | `src-tauri/src/servers/process.rs:720-800`; `electron/services/server-process.ts:213-217` |
| EULA: DB flag AND `eula.txt=eula:true` must agree | **Partial** (flag only; stale false file ignored) | `src-tauri/src/servers/process.rs:516-531`; `electron/services/server-process.ts:95-96` |
| Install: staging, publish-after-validation, installer.log, artifact+launch-shape verify, failure cleanup | **Partial** — pipeline path OK; `server_install` path not | `src-tauri/src/servers/mod.rs:255-330`; `electron/services/runtime.ts:87-118`; contrast `electron/services/pipeline.ts:193-200` |
| Paper (Fill v3, size+SHA-256) install | **Missing** | `src-tauri/src/installer/mod.rs:2326-2395`; `electron/services/installer/core.ts:227-278` |
| Java detect: PATH+JAVA_HOME+registry, major + 64-bit check; ensure: majors 8/17/21/25, SHA-256, resume, staging | **Partial** — no arch check, no registry, no SHA/resume | `src-tauri/src/java/mod.rs`; `electron/services/installer/core.ts:166-209` |
| Full version catalogue per ADR-0007 | **Missing/simplified** (Vanilla all types, Paper mislabelled, one build per loader, NeoForge prefix broken) | `src-tauri/src/installer/mod.rs`; `electron/services/versions.ts:7-49` |
| Structured file logging + crash diagnostics | **Missing** | `src-tauri/src/util/logging.rs`; `src-tauri/src/servers/process.rs:805-1250` |
| Rust unit tests (cargo test, 64+ tests) | **Missing** — only 3 ad-hoc harnesses (`--selftest/mgmttest/ipctest/e2e`) | `src-tauri/**/tests`; `electron/{main,ipc-test,mgmt-test,e2e}.ts` |
| Single-instance plugin | **Ported** | `src-tauri/src/lib.rs:29-35`; `electron/main.ts:49-58` |
| `{code,message}` error serialization | **Ported** via `{__ipc}` envelope (dialog handlers inconsistent) | `src-tauri/src/error.rs:41-51`; `electron/ipc.ts:94-114`; `preload.ts:14-22` |
| Events `server://log/{id}`, `server://status/{id}`, `job://progress/{id}` | **Ported** (channels/payload verified against `src/tauri.ts:676-733`) | `src-tauri/src/util/events.rs:12-30`; `electron/services/server-process.ts:37,209`; `jobs.ts:28` |

## Runtime verification needed by Lead

Run gates **serially** — all Electron test modes share the single-instance lock and (except mgmttest/ipctest) the same `.app-data`; a second launch exits 0 without running tests.

1. `npm run build` → expect exit 0 (tsc renderer + electron + vite). Store output.
2. `npm run selftest` → require the literal `SELFTEST PASS` line **and** exit 0, with no other Electron process running. Note: it writes `.app-data/app-data.json`; snapshot it before/after.
3. `npm run mgmttest` → expect `MGMTTEST PASS` 17/17 (temp root; covers management services, not lifecycle).
4. `npm run ipctest` → expect `IPCTEST PASS`; requires `dist/`; it copies `ipc-result.txt`/`ui-smoke.png` into `.app-data` (side effect to clean).
5. `npx electron . --e2e *> .e2e.out; "EXIT=$LASTEXITCODE"` → expect exit 0; check `.app-data/e2e-result.txt` = `E2E PASS`; then `Get-Process java` (no leftovers) and inspect `.app-data/app-data.json` for stray `e2e-*`/`starting` rows; leftover dirs `servers/e2e-sf5*` are expected until manually cleaned.
6. Paper repro (P0): in DevTools console `await window.electronAPI.invoke('server_install',{input:{name:'paper',loader:'Paper',mcVersion:'1.21.1',ramMb:1024,eulaAccepted:true},jobId:'p1'})` → currently rejects "loader not supported: paper"; after fix creates+starts.
7. Kick the lifecycle: start vanilla; simultaneously `Promise.allSettled([invoke('server_start',{id}),invoke('server_start',{id})])`; count `Get-Process java` (must be 1) and `logs_tail`.
8. Kill semantics: start vanilla, `invoke('server_kill',{id})`, then read `servers_list` → currently `crashed` + UI crash toast; expect `stopped` after fix.
9. Quit orphan: start vanilla, close window, `Start-Sleep 3; Get-Process java` → currently still alive; also confirm `.msm-server.pid`/status cleanup.
10. Store lost-update: with server A running, `invoke('servers_create',{input:{name:'b',loader:'Vanilla',mcVersion:'1.21.1',ramMb:1024}})` then `invoke('server_send_command',{id:A,cmd:'list'})`; `Get-Content .app-data/app-data.json` → B must still exist.
11. Store corruption: copy `.app-data/app-data.json`; overwrite with `{`; launch; if the UI shows an empty list, create a server and confirm the original file was destroyed (restore the copy afterwards).
12. Java contract: `invoke('java_detect',{mcVersion:'1.21.1'})` → check `candidates[0]` keys (currently `javapath`, no `path`/`architectureBits`); UI Settings → Change → valid `java.exe` → currently blocked "Select or install a compatible Java runtime first.".
13. Versions: `loaders_resolve` for 1.21.1 (currently no NeoForge) and 1.20.1; `versions_paper` 1.21.1 `versionType` (currently `snapshot`); `versions_vanilla` for `old_beta`/snapshot entries.
14. Install cleanup: `server_install` loader `Forge`, mcVersion `1.20.1`, loaderVersion `9.9.9`; then `Get-ChildItem .app-data/servers` → partial dir should be absent after fix (currently remains).
15. Spawn failure: `servers_set_java_path` to `C:\nope\java.exe`, `server_start` → expect toastable error, app alive (currently unhandled `error`/hang).
16. Orphan identity: start a vanilla server manually with `java -jar server.jar nogui`, write its PID into another managed server's `.msm-server.pid`, launch app → that process must survive (today it is killed because only `java` image is checked).
17. Single-instance false pass: launch the app (`npm start`), then in a second shell `npm run selftest` → currently exits 0 with no test output; gate should fail loudly.
18. Logging/perf spot checks: grow a server's `logs/msm-console.log` to ~10 MB; `invoke('logs_tail',{id,lines:500})` timing; verify Console open latency.

## Open questions

1. **Scope of data migration**: is a Tauri(`app.db`)→Electron JSON migration required for release? The port plan chose JSON but specifies no import; if this ships to existing Tauri users, B-13 is a release blocker rather than a port gap.
2. **Which spec wins** for version catalogues and events: the port plan claims "same 35 command names/event channels as Rust", while ADR-0007 / `new-server-improvements` require the full provider catalogue and Rust emits `server://readiness/{id}`. The Electron implementation follows neither fully; confirm intended acceptance surface.
3. **`server_start` contract**: Rust returned immediately after spawn (completion via events); Electron resolves only at `Done(` or terminal failure (up to 10 min, e2e depends on it). Is blocking-until-Done intended, or should it revert to fast-return?
4. **Quit-with-running-server policy**: should closing the window prompt/refuse, or silently stop-all with a 3-5 s budget + tree kill (Rust behavior)? Current behavior is neither.
5. **Identity/orphan policy**: is the `-Dtestmultiai.server.id` marker + CIM verification still required for Electron (checklist Phase 2 says it is)? If not, the orphan-reaping safety bar needs an explicit decision.
6. **Paper priority**: is Paper in the release scope (docs yes, e2e no)? If yes, B-01 should block the "P0–P3 complete" claim.
7. **Test isolation**: should `.app-data` inside the repo remain the dev AND gate data root? Using temp roots for selftest/e2e would remove the current gate interference and destructive side effects.
8. **Generic `servers_create` / HTTP-backend paths**: no UI caller for `servers_create` was found; is the command still part of the shipped contract (and therefore its validation gap in-scope)?
