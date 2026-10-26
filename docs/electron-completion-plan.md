# Block Server Manager — Electron migration completion plan

**Status:** approved 2026-10-26 (D1–D12 = recommended, all phases); **Phase 0 complete** (verification foundation, gate green); Phase 1 starting.
**Prepared:** 2026-10-26 · **Workspace:** `H:\TESTMultiAI\20` · **Baseline commit:** `6f05c50` (tag `pre-completion-fixes`; full `.app-data` mirror at `H:\TESTMultiAI\20-backups\app-data-2026-10-26`).
**Inputs:** four independent audits (`docs/audit/01-backend-runtime.md`, `02-frontend.md`, `03-installer.md`, `05-parity-matrix.md`), a Lead audit of the management/content wave (`04-management-content.md`), and a live evidence run (`docs/audit/evidence.md`, screenshots under `docs/audit/evidence/`).

## Implementation log

| Phase | Status | Gate / evidence |
|---|---|---|
| 0 — Safety net & verification foundation | **DONE** | tag `pre-completion-fixes` + baseline commit; `.app-data` 6.6 GB mirror; zero-dep harness (unit via `node:test`, Electron service/contract/UI runners); `npm run verify` = **PASS 9/9**; screenshots under `artifacts/<ts>/`; test modes isolated to temp profiles/data roots; selftest verdict fixed (B-25 partially) |
| 1 — Release blockers | **DONE (with two tracked verification items)** | Store durability/lock + corrupt quarantine + lost-update proof (unit 21 checks); Paper install via Fill v3 (live E2E `paper-install/start/kill-stopped` PASS); pipeline report full DTO + install-report.json + ErrorBoundary (service suite); bounded quit shutdown + tree-kill/status semantics; legacy Tauri importer + startup hook (12 unit checks); curated L4 data bundled with build-contract gate (`runtime-data` PASS). Live proofs: `node scripts/verify.mjs` PASS 9/9; engine e2e PASS incl. Paper/kill (261 s). Tracked: P0-7 verified install → WP-4.3; quit-while-running live proof → WP-8.1 |
| 2 — Lifecycle & process correctness | **DONE** | Staged atomic install publish (new `install-transaction.ts`, shared by server_install + pipeline; record only after validation, EXDEV fallback, installer.log); per-server start reservation + stop-during-boot abort + single crash event + spawn-error io; identity marker `-Dtestmultiai.server.id` + CIM-verified reaping + legacy `server.lock` + tree kill; port allocator + create validation (loader/mc/RAM/port, Quilt rejected) + fail-closed start port conflicts; command-history contract (per-server 100, newest-first, timestamps) + validated single-line console commands + bounded async rotated tail; EULA authority (file+flag AND, atomic settings, containment); IPC sender-frame guard. Evidence: `npm run verify` **PASS 10/10** (new `lifecycle` suite 9 scenarios); engine e2e **PASS 17/17** after the changes (Paper build 232; Modrinth cobbleverse now logs `146 files · 22 unsupported` → bundled L4 curated data is live) |
| 3 — Catalogue & Java | **DONE** | Full ADR-0007 catalogue in `versions.ts` (pure mappers + thin fetchers): vanilla release/snapshot only, Paper 1.21.1 stays release with STABLE build pins, Fabric all loaders, Forge recommended/latest+catalogue, exact NeoForge mapping (1.20.1 legacy; 20.4/21.0/21.1/26.3 families) and modern install coordinate; `validateLoaderPin` wired into `server_install`. New `java.ts`: metadata-first `requiredJavaMajor` + offline 1.x/26.1 fallback, registry/PATH/JAVA_HOME/known-dir detection with 64-bit + timeout parsing, arbitrary-path `validateJava`, Adoptium SHA-256/size-verified ensure with lock/disk preflight/staging, majors 8/17/21/25; Start uses local mapping + inspected configured path (no Mojang wait); `server://readiness/{id}` events + fast-ack `startDetached` (D8) for server_start/restart. Evidence: live probe (`loaders_resolve('1.21.1')` = Paper build 133 STABLE + NeoForge 21.1.265; required Java 1.12.2→8/1.20.1→17/1.21.1→21/26.3→25; detected/validated JDK path shape `{path,architectureBits}`); `npm run verify` **PASS 10/10**; engine e2e **PASS 17/17** after integration |
| 4 — Installer parity | **DONE (core WPs; 4 follow-ups tracked)** | Cancellation: `AbortSignal` through fetch/download/extract/installer child-tree kill + jobs wiring; integrity: `fetchTrusted` per-hop host allowlists (Modrinth/CF/loader/Mojang/Adoptium, live-verified), `downloadFirstAvailable` failover + cache re-hash, archive hardening (reserved names/dupes/symlinks/caps); CF staging: single download listener, navigation/popup allowlist, `.part`→atomic, complete-only list, inspect containment; Modrinth overrides `server-overrides`/protected manager files + reviewed-Include policy; pipeline: optional-default include, conflictingSignals decisions, full plan/report DTO + source-pin drift guard + single-use previews, route-A metadata inference from shipped installer (live: SF5 `forge 1.20.1 47.4.0`) and blank-metadata fail-closed, Quilt rejection, **verified `Done (` boot before publish** with Java pinned (no guessed major), manager-owned port/EULA enforcement, L2/L3 managed-only + CF prune-only. Evidence: `npm run verify` **PASS 10/10** (unit 150/150), engine e2e **PASS 17/17** (Paper/vanilla verified installs; cobbleverse pipeline install with reviewed choices; SF5 inferred metadata). Tracked follow-ups → Phase 8: Fabric `depends.java` preflight, CF-staging live runtime check, `fetchTrusted` for versions/java metadata, old-Forge arg/win_args parsing |
| 5 — Management/content | **DONE (core WPs; UI follow-ups tracked)** | Content: replace-by-project atomic update (staged+hash/trash/rollback, same-name overwrite), toggle/remove idle-only, real `Jobs` job (`begin/isCancelled/signal`, meta after publish, accurate counts), plugin-aware dependency resolver (project_type:plugin, paper/spigot/bukkit/purpur/folia union, F-13), client-only/`mods-disabled` de-dupe; Backups: interval whitelist + clamped maxKept, retention pools (Manual/Auto exact, Pre-* 2 each, World-delete 5, never the new archive), seq-based flush-ack (ring-saturation safe), start-state refusal, `shutdownDuring` stop→archive→restart, ZIP preflight (>4 GiB/entries before read), DOS mtimes, fsync; Worlds: delete safety archive of the **deleted** world+dims, unit-aware export/import round-trip (root/single-folder/server-style, dims, unique names, reject matrix), duplicate dims with job progress, minimal NBT `level.dat` seed/version + corrupt warning, pending ghost cleared after start, async copies; Players: seq-based ring-safe online detection, vanilla/Forge-NeoForge/Paper log parsing, offline whitelist/op/ban/unban atomic JSON edits with usercache→Mojang UUID resolution, running-only actions conflict, maxPlayers from properties; Metrics: one batched PowerShell sample/5s for all servers, per-core CPU normalization, Paper `tps` ≤1/30s parsed via seq, hours 1..168, history retention/async writes/pruning; Settings: Java-properties escapes (`\uXXXX`, `\t\n\r\f`, separators), line continuation, UTF-8/CRLF-preserving merge, EULA file-truth + atomic rollback already in place. Gate expanded: **mgmttest 17→35 granular checks, service suites 44→80 checks (115 total)**; `npm run verify` **PASS 10/10** (unit 209/209); engine e2e **PASS 17/17**. Tracked to Phase 6/8: durable content rollback snapshot including mods/plugins, world copy/export cancel, `content_cancel` IPC/UI, UI consumption of `shutdownDuring`/`jobId`/`seed`/`warning`/`skipped` |
| 6 — Frontend | **DONE (core WPs; mock-mode/live-UI-install tracked)** | Store/shell: code-preserving toasts (F-19), silent `refreshServers` so mutations never flash "Loading servers" (F-06), in-place DTO patching + activeId reconciliation (F-08), `useActiveServerRequest`/`useLatestRequest` stale-response guards (F-07), readiness→`startingPhase`/`busy`/`isBusy`, fail-closed bridge screen when preload is missing (F-11, no silent mocks), ErrorBoundary recovery; Create: Retry for catalogue/loader/Java failures, Java `{path,architectureBits}` override validation, debounced port-conflict blocking with suggested port, Back disabled mid-install + unmount cleanup/cancel, Retry re-preview, default-include optional review with conflicting-signal choices, verified-install (`verify-boot`) report card, `.mrpack`/CF input validation — and **decomposed 2,503→392 lines into 28 modules (<400 each)** (F-21); Tabs: all 8 aligned to `app-tabs.md` (Overview banners/toolbar/readiness, Console backend log export/attach state, Players offline ops + confirmations + spec table, Worlds seed/warning/stopped-gated export/job progress/pending badges, Backups shutdown-during/schedule rollback/retention+excludes copy/local timestamps, Metrics core-normalized CPU/null-safe TPS/disk/range selector/no dead controls, Settings dirty-diff EULA/restart scoping/Java bits/advanced link, Content idle-gated actions/skipped feedback/cancel now enabled via new `content_install_cancel`); components: modal role/focus-trap/Escape/focus restore, live-region toasts, header readiness labels; backend/adapters gaps filled (`content_install_cancel`, `WorldDto.seed/warning`, backup `shutdownDuring`, world `jobId`). Verification: expanded real-UI E2E with seeded backends — **20+ checks, 19 screenshots, 0 renderer errors**, catalogue options now asserted populated; `npm run verify` **PASS 10/10** (unit 209, services 80, mgmttest 35, contract 66 commands); bundle 359 kB. Tracked: mock/browser-mode paths build-covered only, outage-retry branches not simulated, a full modpack install through the wizard remains Phase-8 UI matrix |
| 7 — Architecture/security/docs | **DONE (core WPs; Tauri archival tracked to Phase 8)** | Contracts: new `shared/contracts.ts` (canonical 71-command tuple + DTOs) and `electron/services/validate-ipc.ts` (per-command IPC-boundary arg validation: path-safe ids/tokens, strict ints/enums/bools/objects, unknown→not-found); contract gate proves shared list ↔ Electron runtime list ↔ renderer list ↔ handler map ↔ minimal payloads, and renderer DTO drift was fixed (`player_action` → `PlayerDto|boolean`, `server_get` nullable, `MinecraftVersionDto.support`, `content_install.skipped` required); root tsconfig includes `shared/`. Runtime simplification (D5/D6): all `@tauri-apps/api` imports and `isTauri` branches removed from the renderer adapter (Electron | HTTP only), mock data is explicit dev-only (`VITE_MOCK_BACKEND=1`) with fail-closed browser screen, `@tauri-apps/api` dependency dropped, stale `frontend-export/` artifact retired; `src-tauri/` documented dormant/unbuilt in **ADR-0020** and docs. Security: strict CSP injected into the built document only (dev HMR preserved), navigation/window-open allowlists + http(s)→OS browser, permission requests deny-all, webview attach denied, packaged devtools disabled; CurseForge key in `safeStorage` (encrypted `curseforge-key.enc`) with 0600-intent file fallback, Settings key section (never echoes key), installer reads through `curseForgeKeySync` with cache reset on change; sender-frame guard + IPC arg validation. Diagnostics: rotating `logs/launcher.log` (5×10 MiB), JSONL daily timeline, redacting support bundle (versions/platform/server summary/log tail/timeline/redacted app-data; excludes worlds/backups/mods/secrets), crash handlers wired in main, Settings "Create support bundle" button + `diagnostics_bundle`/`diagnostics_recent` IPC. Docs: new top-level README, rewritten architecture overview, [verification guide](verification.md), [management/content spec](specs/management-content.md), ADR-0020, docs index/status banners updated. Evidence: `npm run verify` **PASS 10/10** (unit 243, contract 71 commands, services/ipctest/uitest green; CSP-protected build renders with zero console errors). Tracked to Phase 8: Tauri-tree archive/delete after sign-off, renderer imports of `shared/` (gate currently bridges via AST), CSP CDN hosts if renderer networking is added, pattern-based redaction limits |
| 8 — Full verification | in progress | target: full matrix incl live engine E2E + installer matrix, manual real-app walk + screenshots, 24 h soak, final audit/plan closure |

---

## 0. TL;DR

The Electron port boots, persists servers, and its demo path works — the internal E2E passes 12/12, all four ad-hoc gates are green, and the renderer renders every tab against the real backend. But the migration is **not complete or reliable**:

- **8 release-blocking defects** are reachable from normal user flows: Paper server creation is impossible (proven live); the Create wizard blanks the whole app after any modpack install (code-confirmed: the renderer dereferences a field the backend never returns); quitting can leave servers running untracked; the JSON store can silently lose servers and wipes a corrupt file (partly reproduced live); there is no migration of existing Tauri data; the advertised 4-layer client-mod defense ships as 3 layers; an install can report success for a server that has never booted; and a corrupt/truncated backup or world ZIP raises an uncaught zlib error in the main process and leaves restore/import hanging (probe-reproduced).
- **~30 high-severity defects** cover lifecycle races, kill misreporting, Java contract drift, missing NeoForge, broken cancellation, non-atomic installs, EULA bypass, backup/settings/content correctness, and weak renderer hardening.
- The gap exists because the migration was **verified by demo, not by contract**: all gates are happy-path, backend-only (they never render the install-completion screen), mutate the dev data root, and silently pass when another instance is running.
- The management/content wave is large and mostly functional but **hardening-poor and test-thin** (17 happy-path checks), and it is **new functionality**: the dormant Rust modules for backups/worlds/players/metrics/content are empty stubs, so these tabs must be judged against the specs, not Rust parity.

This plan closes every confirmed defect in phases, adds the missing verification layers (unit → contract → service integration → real UI E2E → install matrix → soak), and defines a release gate. It needs **12 decisions** from you before work starts (§6), and it respects your standing rule: backup/tag the current state first, then change code.

---

## 1. Objective and definition of done

**Goal:** every feature the app exposes works correctly, reliably, and as intended — the 35-command Tauri feature set at behavioural parity, plus the management/content features the UI already ships — and this is proven by running the real app, not by build/test gates alone.

**Done when all of the following hold:**

1. No open P0/P1 defect from `docs/audit/*` unless explicitly deferred and approved.
2. Every renderer command has a contract test asserting its payload, return shape, and `{code,message}` errors; every persistence/target mutation has a service test with a temp data root.
3. Real-UI E2E covers: launch → server list → create/install for **Vanilla, Paper, Fabric, Forge, NeoForge**; Modrinth and CurseForge pack install (success, failure, cancel) with the install report rendered; start until `Done (`, console commands, stop/restart/kill; every management tab action; settings save on a running server; quit with a running server leaves no processes; restart persistence; legacy-data import fixture.
4. The existing install routes (Vanilla cycle, Modrinth cobbleverse, CF SkyFactory-5 key-mode) still pass, plus at least one pack per new loader and failure/cancel injections.
5. A 24 h soak with a running server, auto-backup, and metrics produces no leaks, no orange status, no orphan `java`/`powershell` processes, and bounded log/metrics growth.
6. The acceptance walkthrough with screenshots matches `docs/specs/app-tabs.md`, and docs no longer claim more than is verified.

---

## 2. Evidence base and baseline (verified 2026-10-26)

| Gate | Result |
|---|---|
| `npm run build` (electron tsc + renderer tsc + vite) | PASS |
| `npm run selftest` | PASS — but tests phase-0 handlers only and cannot fail on string results (B-25) |
| `npm run mgmttest` | PASS 17/17 happy-path service checks |
| `npm run ipctest` (real preload/renderer chain) | PASS |
| `electron . --e2e` | PASS 12/12 — Vanilla, Modrinth cobbleverse, CF SF5 key-mode, zip inspect |
| Independent UI probe (real renderer + IPC, temp root) | all 8 tabs + Create Configure render, no renderer errors (CSP warning only) |
| Command coverage | 65 Electron handlers ↔ 65 renderer invocations ↔ all 35 Rust command names present |
| Target probes | Paper install throws `loader not supported: paper`; NeoForge absent for 1.21.1; Fill status mis-mapped to snapshot; Java `javapath`/`path` drift; store lost-update reproduced; `players_list.maxPlayers` 20 vs configured 10 (API-contract only — the UI ignores the field, see M-06); dev data has duplicate ports and orphan server folders |

Full evidence: `docs/audit/evidence.md`.

---

## 3. Findings register (deduplicated release view)

Full lists with file:line evidence live in the audit reports. Counts: backend/runtime 29 (B-01…B-29), frontend 23 (F-01…F-23), installer 23 (INST-001…INST-023), management/content 23 (M-01…M-23), parity 35 commands (6 OK / 21 PARTIAL / 8 BROKEN / 0 missing + 16 cross-boundary bugs). The management report also corrects six provisional hypotheses (notably M-06 has no visible UI mismatch) and adds seven probe-confirmed defects (M-17…M-23).

### 3.1 Release blockers (P0)

| ID | Defect | Evidence |
|---|---|---|
| P0-1 | **Paper server creation is impossible.** `installLoader` has no `paper` branch; UI offers Paper, engine throws `loader not supported: paper`. | B-01, live probe |
| P0-2 | **The app blanks after any modpack install.** Backend `report` omits `loader/planId`; Create dereferences `pipelineReport.loader.minecraftVersion`; no ErrorBoundary. | F-01, parity #1 |
| P0-3 | **Quit with running servers is fire-and-forget.** `before-quit → void shutdown()`; no await/preventDefault/tree-kill → orphaned `java`, unsaved worlds. | B-02 |
| P0-4 | **Store can lose or wipe user data.** `pushCommand()` saves a stale snapshot (proven: a created server disappeared); corrupt `app-data.json` becomes an empty store and the next write destroys it. | B-06, B-07, live probe |
| P0-5 | **No Tauri→Electron data migration.** Different data roots; existing `app.db` + server folders are ignored → empty server list after upgrade. | B-13 |
| P0-6 | **Advertised 4-layer defense is 3 layers in every build.** Curated `data/*.json` is never copied to `dist-electron`; per-pack keys use project ids instead of slugs; learned-file write crashes Start. | INST-001/008 |
| P0-7 | **Install reports success without a verified start.** The pipeline never validates launch shape or reaches `Done (`; E2E boots separately, masking it. | INST-002 |
| P0-8 | **Corrupt/truncated backup or world ZIP crashes/hangs the app.** The shared extractor has no per-entry stream `error` handler; probe: `Z_DATA_ERROR` uncaught, extraction promise never settles, 0-byte partial file. | M-17 |

### 3.2 High severity (P1) — grouped

- **Lifecycle/process:** kill reports `crashed` + crash toast (B-05); duplicate-start race (B-03); crash-retry loses log tail and spams crash events (B-04); spawn `error` unhandled (B-10); stop/quit hangs/tree-kill gaps (B-16/B-17); orphan reaping trusts image name only, no identity marker (B-14); start does network provisioning and skips Java validation (B-15); stop-during-boot/restart races (B-17).
- **Contracts:** Java `javapath` vs `path` mismatch breaks display + override (B-08/F-03); pipeline report/plan DTO incomplete (INST-014, parity #1); CF staged timestamp ms vs s (F-14); telemetry/log/bytes promised but absent (parity #9); `install-report.json` never written (parity #10); metrics channel naming drift (parity #13).
- **Catalogue/Java:** NeoForge missing for 1.20.2–1.21.x + wrong modern install URL (B-11); Paper version/channel mislabelling and one-choice-per-loader catalogue vs ADR-0007 (B-12); Java 25 vs exposed MC 26.x mismatch (decision D12); detect lacks arch/timeout/registry/arbitrary-path validation (B-15, parity Java).
- **Installs:** non-atomic final-dir installs, record-before-validation, partial dirs left (B-09/INST-004); cancellation is decorative (B-21/INST-003); archive can accept EULA/overwrite manager paths (INST-005); CF route A blank MC/loader + guessed Java (INST-006); L3 cross-platform injection + no pre-publish hard-dep block (INST-007/017); optional-file policy regression (INST-009/F-05); no source failover/cache re-verification (INST-010); no host/redirect allowlist (INST-011); previews single-use/drift unchecked (INST-013); route B policy reversal vs ADR-0012 (INST-018); Quilt installable via IPC though ADR-0005 removed it (parity #16).
- **Management P1:** content update leaves the old jar active (M-01); settings save silently stops a running server (F-02/M-05); world-delete "safety backup" archives the wrong world (M-18); world export→import is rejected / silently drops dimensions and duplicate drops the nether/end (M-19); `players_list` loses all online players once the 5000-line ring saturates (M-20); restore `reset` does not reset and deletions sit outside rollback (M-23).
- **Management P2/P3 (still required for "works as intended"):** schedule interval unvalidated (M-03; `maxKept` is clamped), retention off-by-one + prunes Pre-* safety archives (M-04), toggle allowed while running (M-02), content job/cancel/meta/plugin-deps (M-07), `cpSync` freezes the main thread (M-08), backup flush fixed-sleep (M-10), settings non-atomic (M-11), EULA truth from file existence (M-12), metrics cost/CPU normalisation/TPS never sampled (M-13), Forge/NeoForge/Paper player-log formats + offline management absent (M-21), Java properties escaping/CRLF (M-22), zip timestamps/junction handling (M-14), `maxPlayers` API-contract drift (M-06, no visible UI mismatch), pending-world polish (M-09), UI spec gaps (M-15), orphan folders/metrics/content metadata on delete (M-16).
- **Frontend/security:** Create has no recovery from catalogue/Java failures and can trap the user in first-run (F-04); every mutation tears the shell to "Loading servers" (F-06); stale data races (F-07); stale `activeId` after delete (F-08); partial settings apply reported as failure (F-09); Back enabled mid-install / preview leaks (F-10); silent mock fallback if preload fails (F-11); export enabled when backend needs stopped (F-12); no CSP/navigation/window-open/sender checks, `openExternal` unvalidated, no id/path validation across handlers (B-24, parity security).

### 3.3 Medium/low (P2/P3)

Everything else in the four reports: console contract/perf (B-18/B-19/B-26), port model/validation (B-22/B-23), error-code/status drift (B-27), store durability details (B-28), stale dead code (B-29), all remaining F-xx and INST-xxx items (progress fidelity, CF staging listener leaks, archive limits, metrics sampling cost/TPS strategy, players/backups spec drift, a11y, Create.tsx monolith, docs drift, gate integrity).

---

## 4. Systemic root causes (fix these, not just symptoms)

1. **Ported by surface, not contract.** All 35 command *names* exist, but payload shapes, validation, error codes, and semantics drifted (javapath/report/metrics-channel/CF-units/EULA). No shared type or runtime validation at the IPC boundary.
2. **No transaction/staging discipline** outside the modpack pipeline: installs write the final directory, records are created first, cancellation is cooperative-only.
3. **Async ownership is ad-hoc:** fire-and-forget shutdown, no per-server lifecycle queue/reservation, listeners registered after state checks, store mutations without a lock.
4. **Verification is demo-based:** four gates all assert happy paths, backend-only, share the dev data root, and can silently pass; none renders the install-completion UI, negative path, or a second instance.
5. **Provider catalogues were simplified** instead of ported from the documented contract (ADR-0007, ADR-0014, ADR-0018), so advertised loaders/versions fail late.
6. **Build packaging gap:** claimed runtime data (`installer/data`) is not part of the build output; there is no packaging step at all.
7. **Storage migration was never designed** (SQLite→JSON, data-root rename) — acceptable architecture change, missing transition.
8. **Legacy dual-runtime surface** (Tauri dormant, HTTP export, browser mocks) doubles maintenance and lets stale copy/dead paths survive.
9. **Docs claimed completion ahead of verification** ("P3 complete / PORT COMPLETE") which hid the gaps.

---

## 5. Scope policy: what counts as an "existing feature"

"All existing features" in this plan means:

- **Tauri feature set:** the 35 registered Rust commands and their observable behavior (lifecycle, console, Java, versions/loaders, installs, Modrinth/CF pipeline, persistence). Behavioural parity is required where the Rust/ADR/spec contract is explicit; the JSON store is an approved architecture change.
- **Live UI surface:** every screen/action the current renderer exposes, including the management/content tabs (backups, worlds, players, metrics, settings, content) — these are new features whose contract is `docs/specs/app-tabs.md` plus the port plan's management-completion section.
- **Explicitly deferred by prior docs** (see §11) are out of scope unless you overrule: RCON, playit.gg, i18n, auto-update, full files editor, schedules beyond backups, packaging/NSIS, roles/DBs/network/activity.

---

## 6. Decisions required before implementation

| # | Decision | Recommendation |
|---|---|---|
| D1 | **Legacy data migration scope.** Import existing Tauri `%APPDATA%\com.blockserver.manager\app.db` + `servers/*` into the JSON store (one-shot, dry-run, marker, source untouched), or explicitly reset and document? | **Import** (node:sqlite is available in Electron 45's Node 24; fixture-test it). Only relevant if the app ever shipped as Tauri to this user. |
| D2 | **Test infrastructure additions.** May I add dev dependencies (vitest/playwright) or keep zero-new-deps? | **Zero-new-deps first:** Node built-in `node:test` for units/services + an in-app Electron UI harness (BrowserWindow + `executeJavaScript` + `capturePage`, same technique as `--ipctest`). Add Playwright only if the harness proves insufficient. |
| D3 | **Paper/NeoForge/Quilt scope.** Implement Paper + all NeoForge families (recommended), or hide unsupported loaders? | **Implement** — the UI already advertises them and the specs require them; also reject Quilt server-side per ADR-0005. |
| D4 | **Commit strategy for the WIP wave.** Commit the current uncommitted management/content wave as a baseline (tag `pre-completion-fixes`) before changing code? | **Yes** — required by your backup-before-refactor rule and needed for clean rollback/review. |
| D5 | **Tauri dormant code.** Keep as reference through the fixes, then archive/remove? | Keep until §Phase 7, then remove from the build path and archive under `legacy/` (or delete with your approval). |
| D6 | **HTTP/browser-mock deployment target.** Keep the framework-neutral HTTP backend + web export maintained, or retire it? | Retire the stale `frontend-export` artifact; keep mock mode only behind an explicit dev flag, not as implicit fallback (F-11). |
| D7 | **Quit policy with running servers.** Auto stop (graceful, bounded) + kill survivors, or prompt/refuse? | **Auto stop with 5 s budget + tree kill** (Rust behavior), showing a "stopping servers…" state. |
| D8 | **`server_start` contract.** Keep blocking until `Done (` (current, up to 10 min × retries) or return fast + readiness events (Rust behavior)? | **Fast ack + `server://readiness/{id}` events**, renderer shows starting→running. Removes UI hangs and matches parity. |
| D9 | **Defense-layer policy.** Keep the reference's boot-time L2/L3 model with verified install (`Done (`), and which dependency policy: Modrinth fetch-allowed, CurseForge prune-only, arbitrary user servers no fetch? | **Verified install + boot-time L2/L3 for managed installs only; Modrinth fetch allowed; CF prune-only; never mutate unmanaged servers.** |
| D10 | **Packaging.** Add electron-builder/NSIS (and copy `installer/data` into resources) now or defer? | **Defer packaging**, but add a build-contract check that required runtime data lands in `dist-electron`/resources (P0-6 must not depend on packaging). |
| D11 | **CurseForge key UX.** Manual `<dataRoot>/curseforge-key.txt` only, or a Settings field with OS `safeStorage` + validation + rotation without restart? | **Settings + safeStorage** (keep file fallback), since key-mode is advertised. |
| D12 | **Java 25 / Minecraft 26.x.** The catalogue exposes 26.x (Java 25 required) while the spec said "do not advertise Java 25". Support Java 25 provisioning or gate 26.x out? | **Support Java 25** (Adoptium serves it) and add majors 8/17/21/25; alternatively hide 26.x. Must be explicit before installs of listed versions fail. |

Additional confirmations: use the project's existing English docs/code, Vietnamese conversation; keep `docs/audit/` reports in the repo as the findings appendix.

---

## 7. Phased remediation plan

Each work package (WP) is sized **S** (≤0.5 day), **M** (1–2 days), **L** (3–5 days), assumes tests are written with the fix, and has a gate that must be green before the next WP in the same stream. Phases 1–6 may run in parallel streams after Phase 0 as shown in §8.

### Phase 0 — Safety net and verification foundation (1–1.5 days)

| WP | Scope | Findings | Size |
|---|---|---|---|
| WP-0.1 | Backup/tag/commit: tag `pre-completion-fixes`; commit the management/content wave + `docs/audit/` as separate commits; snapshot `.app-data` to a dated backup folder (gitignored) | D4, taste rule | S |
| WP-0.2 | Test harness foundation (no new deps): `electron/test/` runner + helpers (temp data root, direct handler invocation, fake stdio child, fixture builder for jars/zips/worlds/properties, HTTP fixture server), scripts `test:unit`, `test:services`, `test:contract`, `test:ui`, `verify` (clears `ELECTRON_RUN_AS_NODE`, refuses when another instance runs, serial, temp roots, artifacts dir) | B-25, gate integrity | M |
| WP-0.3 | Shared contract skeleton: `shared/contracts.ts` with all DTOs/command map/error codes; electron + renderer compile against it (types only, no behaviour) | root cause 1 | M |
| WP-0.4 | Docs truth pass: correct `docs/electron-port-plan.md` completion claims and link audit reports; add "how to verify" to README | root cause 9 | S |

**Gate:** `npm run verify` green from a clean build; baseline evidence recorded; rollback tag exists.

### Phase 1 — Release blockers (3–4 days)

| WP | Scope | Findings | Size |
|---|---|---|---|
| WP-1.1 | **Store durability + serialization:** `Store.mutate()` with a real write lock (per-dataRoot promise mutex or lockfile), read-through reload in every mutator (incl. `pushCommand`), ENOENT-only empty, corrupt file quarantine (`.corrupt-<ts>`) + typed error + UI banner, `.bak`, unique tmp, fsync, row validation, history cascade | P0-4/B-06/B-07/B-28 | L |
| WP-1.2 | **Paper install:** Fill v3 build resolve (STABLE latest / chosen build), `server:default` size+SHA-256 verification, `server.jar` publish; loader choice carries build id; extend catalogue types | P0-1/B-01 | M |
| WP-1.3 | **Pipeline report + renderer resilience:** return full `PipelineInstallReport` (schemaVersion, planId, serverId, createdAt, status, sourcePin, loader, files, stages, warnings, errors); write `<server>/install-report.json` or delete the UI claim; ErrorBoundary + report card rendering; UI E2E install assertion | P0-2/F-01/INST-014/parity #1,#9,#10 | M |
| WP-1.4 | **Shutdown lifecycle:** `before-quit` preventDefault + single-quit guard + bounded shutdown (stdin stop, 5 s total, `taskkill /T /F` survivors), statuses/pid cleanup; window-close path uses it; integration test with fake child | P0-3/B-02/B-16 | M |
| WP-1.5 | **Kill/stop intent + spawn errors:** explicit user-stop flag, final `stopped` + log line, tree kill; `proc.on('error')` rejects start with coded error and cleans reservation; validate java executable before spawn | B-05/B-10 | M |
| WP-1.6 | **Legacy migration (D1):** detect Tauri data root, import servers/backups/history/settings via `node:sqlite`, copy/reuse server folders, marker file, dry-run + first-run confirmation, fixture test | P0-5/B-13 | L |
| WP-1.7 | **Bundle curated L4 data + fix reachability:** build step copies `installer/data/*.json` into `dist-electron` (or import as TS), pack keys by slug, learned file under dataRoot, `appendLearned` never crashes Start; build-contract test | P0-6/INST-001/008 | M |
| WP-1.8 | **Extractor crash/hang hardening:** attach `error` handlers to both entry streams and zipfile, reject + destroy + clean staging on failure; validate archive EOCD before restore/import; fixture tests with truncated/corrupt ZIPs for backup restore and world import | P0-8/M-17 | S |

**Gate:** all eight blocker repros pass; extended E2E (Paper, quit-while-running, corrupted store, lost-update, report UI, corrupt-ZIP restore/import) green.

### Phase 2 — Lifecycle and process correctness (2–3 days)

| WP | Scope | Findings |
|---|---|---|
| WP-2.1 | Per-server lifecycle queue/reservation; explicit user-stop flag; crash-retry captures ring before map delete and emits one terminal `crashed`; stop-during-boot short-circuit | B-03/B-04/B-17 |
| WP-2.2 | Process identity/orphans: add `-Dtestmultiai.server.id` marker (jar + argfile modes), `.msm-server.pid` + legacy `server.lock`, CIM command-line verification fail-closed, tree kill, reap tests with a fake java | B-14 |
| WP-2.3 | Port model: `allocatePort` (records + OS probe), create-time uniqueness/validation, start fails closed on occupied port (explicit message), no silent rewrite | B-22 |
| WP-2.4 | Install staging/publish/rollback shared by `server_install` and pipeline: staging dir + `installer.log`, artifact/launch-shape verification, atomic rename, record insert after success; no visible/partial rows | B-09/INST-004 |
| WP-2.5 | EULA authority: parse `eula.txt`, DB+file must agree, fail closed, write only on explicit acceptance; Settings truth | B-20/M-12 |
| WP-2.6 | Console contract: command validation (non-empty, single line, capped), 4096-byte line truncation + lossy decode, bounded async tail incl. rotation, 10k/16 MiB caps, per-server 100-entry history with timestamps + cascade | B-18/B-19 |
| WP-2.7 | IPC validation layer: id/name/path containment helpers used by every file-touching command; sender-frame/origin check; `server_open_folder` containment | parity #14/#15, B-24 |

**Gate:** lifecycle stress test (50 start/stop/restart/kill cycles, duplicate starts, stop-during-boot) leaves zero orphan processes and consistent statuses.

### Phase 3 — Catalogue, Java, and provider parity (2–3 days)

| WP | Scope | Findings |
|---|---|---|
| WP-3.1 | Full catalogue per ADR-0007: vanilla releases (+opt-in snapshots, never `old_*`), Paper versions ∩ support ∩ builds with channel/stable labels and build ids, full Fabric/Forge/NeoForge catalogues incl. exact NeoForge mapping table (1.20.1 legacy `1.20.1-`, 1.20.2+ families `20.2…21.1`, 26.x modern), server-side pin validation | B-11/B-12 |
| WP-3.2 | Java parity: unified `JavaCandidate {path, major, architectureBits, source}`; detection (PATH/JAVA_HOME/registry/known/app), 64-bit + ≥ required, 5 s timeouts, arbitrary-path validation; ensure (Adoptium SHA-256/size, install lock, resume, disk preflight, progress); start uses local map + validation, never network; majors 8/17/21/25 (D12) | B-08/B-15/F-03/F-04 |
| WP-3.3 | Start/readiness contract (D8): fast ack + `server://readiness/{id}` payloads; renderer handles starting→running; remove blocking-until-Done UI assumptions | parity #12 |

**Gate:** live `loaders_resolve` returns Paper builds + NeoForge for 1.12.2/1.20.1/1.21.1/26.x; Java matrix tests (1.12.2→8, 1.20.1→17, 1.21.1→21, 26.x→25) pass offline after provision; install one server per loader.

### Phase 4 — Installer/modpack parity with the proven reference (4–5 days)

| WP | Scope | Findings |
|---|---|---|
| WP-4.1 | Cancellation & jobs: AbortSignal through fetch/download/extract/installer child kill, `jobs.begin` at every command start (incl. java_ensure), duplicate-id rejection, sticky cancel, byte/log progress | B-21/INST-003/020 |
| WP-4.2 | 4-layer defense per D9: L2 with curated protect set at install/launch, L3 scope (Modrinth fetch, CF prune-only, managed-only), `server-overrides/`, no mutate-on-every-start, L4 precedence | INST-001/007/008/015/016 |
| WP-4.3 | Verified install: launch-shape validation + one `Done (` boot (timeout) before success; failure → rollback + failed report with tail | INST-002 |
| WP-4.4 | Integrity/allowlist/failover: ordered candidates with per-candidate hashes, cache re-verification, redirect-hop host allowlists, archive hardening (reserved names, duplicates, symlinks, caps), fixtures | INST-010/011/019 |
| WP-4.5 | Route A/B metadata & reporting: infer/persist real MC+loader+Java for server packs, shipped-installer vs prebuilt paths, full report/plan/install-report.json, preview single-use + drift check, manual-required list, CF key UX (D11) | INST-006/013/014/018 |
| WP-4.6 | Optional-file & overrides parity: optionalDefaultKeep default include, conflictingSignals, server-overrides/client-overrides, excludeFn on overrides, protected manager paths | INST-009/015 |
| WP-4.7 | Route C staging hardening: navigation/download allowlist, one listener, atomic complete-zip publish, cancel events, inspection name validation | INST-012 |
| WP-4.8 | Policy alignment: server-side Quilt rejection (ADR-0005), Fabric `depends.java` preflight, launch arg/win_args parsing, hand-required diagnostics | INST-017 |

**Gate:** reference parity matrix (§03 report) re-run: every ✅/⚠️ row has evidence from a fixture or live run; installs still pass for cobbleverse/SF5; cancel test stops within ~2 s; verified-start proves a broken pack fails.

### Phase 5 — Management/content correctness (2–3 days)

| WP | Scope | Findings |
|---|---|---|
| WP-5.1 | Content: update-replaces-old atomically (pre-update snapshot includes mods/plugins), toggle stopped-only, job registration/cancel, stage-then-publish + meta only for published files, Modrinth `project_type:plugin` deps for Paper, client-only filtering, version filtering | M-01/02/07, F-13 |
| WP-5.2 | Backups: interval whitelist + maxKept (already clamped) validation, retention semantics (Manual/Auto only, bounded Pre-* pool, prune World-delete), flush confirmation (bounded) instead of fixed sleep, jobId progress already wired, shutdown-during option per spec (or spec change) | M-03/04/10, F-16/F-18 |
| WP-5.3 | Worlds: delete-safety backup must archive the deleted world + dimensions (M-18), export/import as one world unit incl. nether/end, duplicate dimensions, parse `level.dat` (seed/name/corruption), async copy/export/import with progress+cancel, `reset` restore semantics + rollback coverage, pending lifecycle cleanup, export gating | M-08/09/18/19/23, F-12 |
| WP-5.4 | Settings/players/metrics: atomic settings update + no stop-on-save + EULA truth, Java Properties escapes/CRLF, player log formats (Forge/Paper) + ring-safe online detection + offline management/Mojang failure handling, metrics batching/CPU normalisation/TPS strategy/history cleanup, maxPlayers API contract, Players tab spec alignment | M-05/06/11/12/13/20/21/22, F-15/F-17 |
| WP-5.5 | Zip/extractor safety: preflight size/entries, zip-slip/reserved/ADS/Unicode fixtures, clear >4 GiB error, timestamps/fsync/junction behaviour | M-14, M-17 (with WP-1.8) |

**Gate:** service integration suite (corrupt-ZIP restore/import, backup→delete→restore of the *deleted* world, export→import round-trip with dimensions, schedule tick, content update A→B, settings matrix, ring-saturated player list, metrics history) green; mgmttest expanded from 17 to ≥80 checks.

### Phase 6 — Frontend correctness and UX (2–3 days)

| WP | Scope | Findings |
|---|---|---|
| WP-6.1 | Global resilience: ErrorBoundary, `{code,message}` toasts, per-screen error/retry, preload-failure detection (no silent mocks) | F-01/F-11/F-19 |
| WP-6.2 | Shell/store state: patch-in-place for mutations (no full "Loading servers" flash), activeId cleanup, request cancellation/staleness guards | F-06/07/08 |
| WP-6.3 | Settings/Create/Java flows: dirty tracking, no stop-on-save, validation, port conflict, no first-run dead end, mid-install Back guard/discard, retry for catalogue/Java failures | F-02/04/09/10/F-20 |
| WP-6.4 | Tab spec alignment: optional-file choices, export gating, timestamps, metrics display, backups options, Players disabled states/reasons/confirmations, first-run/overview additions | F-05/12/14/15/16/17/18/F-23 |
| WP-6.5 | `Create.tsx` decomposition (behaviour-preserving after logic fixes): steps/hooks/components <400 lines each; a11y (modal roles/focus, labels, focus trap) | F-21/F-22 |
| WP-6.6 | Mock/dead-code cleanup: mocks only behind explicit dev flag; remove stale "(mock)" copy from reachable paths; remove dead Tauri/HTTP wrappers after D5/D6 | F-11, B-29 |

**Gate:** UI E2E walks every tab + Create flows with screenshots; no console errors; spec diff list closed.

### Phase 7 — Architecture consolidation and hardening (2–3 days)

| WP | Scope | Findings |
|---|---|---|
| WP-7.1 | Enforce shared contracts: typed command map + runtime arg/return validation at IPC boundary; delete duplicated DTOs; compile-time coupling both projects | root cause 1 |
| WP-7.2 | Runtime simplification per D5/D6: remove/archive Tauri build path, one adapter, regenerate or delete `frontend-export`, document supported backends | root causes 8, D5/D6 |
| WP-7.3 | Security hardening: CSP + session headers, window-open/navigation allowlists, openExternal scheme allowlist, sender checks, minimal preload surface, CF key safeStorage (D11), secrets rotation | B-24, INST-011/012 |
| WP-7.4 | Diagnostics: rotating `logs/launcher.log`, lifecycle/install timeline, crash evidence, support-bundle command | B-26 |
| WP-7.5 | Docs/ADR/repo hygiene: honest port-status docs, new specs for management/content + test strategy, ADR-0020 "Electron sole runtime", README run/verify, remove stale claims/artifacts | root cause 9 |

**Gate:** `tsc` clean with no duplicated contract types; no dead runtime branch reachable in prod; docs reviewed against code.

### Phase 8 — Verification and release gate (2–3 days + 24 h soak)

| WP | Scope |
|---|---|
| WP-8.1 | Complete automated suite: unit (pure helpers), contract (all 65 commands: payload/schema/errors), service integration (all storage/backup/world/settings/metrics/content/zip paths), UI E2E (tabs, Create for 5 loaders, Modrinth/CF install success/failure/cancel + report render, settings save while running, quit, restart persistence, migration fixture) |
| WP-8.2 | Engine/install matrix: Vanilla/Paper/Fabric/Forge/NeoForge; Modrinth pack; CF routes A/B/key-mode; failure + cancel injections; legacy Java 8 pack (RLCraft-class); Unicode path; restored backup server start |
| WP-8.3 | Non-functional: console 10 MB tail <100 ms, UI with 10k lines smooth, install memory, metrics overhead, no orphan processes after quit, 24 h soak (running server + auto-backup + metrics) with bounded growth |
| WP-8.4 | Manual acceptance walkthrough with screenshots per tab/flow vs `docs/specs/app-tabs.md`; user demo |
| WP-8.5 | Release checklist: no open P0/P1 (or approved deferrals), version bump, docs updated, migration tested on a copy of real data, rollback plan |

**Release gate:** `npm run verify` (all layers) + install matrix + soak + manual walkthrough. Only then claim completion — per your rule, the claim must include a running app and screenshots, not just gates.

---

## 8. Execution model (Agent Teams) and sequencing

```
Phase 0 (Lead, serial)
  └─> Phase 1 blockers (Lead + 2 agents; WP-1.1/1.4/1.5 stream A, WP-1.2/1.3/1.7 stream B, WP-1.6 stream C) — serialized Electron gates
        ├─> Phase 2 A (lifecycle/store/console)
        ├─> Phase 3 B (catalogue/java)         ─┐
        ├─> Phase 4 C (installer)               ├─ parallel, disjoint write scopes
        ├─> Phase 5 D (management)              │
        └─> Phase 6 E (frontend)     <──────────┘ (E waits on WP-1.3/3.2 contracts)
Phase 7 (contracts/security/docs) after features stabilize
Phase 8 (verification) Lead-owned, serial gates + subagent reviewers
```

Rules: each WP gets a shared task with an explicit write scope (files/dirs); no two agents edit the same file; the Lead owns `shared/contracts.ts`, `electron/ipc.ts`, `package.json`, and test-harness utilities; every fix lands with a failing-repro-first test where feasible; independent reviewer agent per PR-sized batch (max 3 rework loops, then Lead decision); all Electron test runs are serialized (single-instance lock, temp roots).

**Effort:** ~30–38 engineer-days of work; with 3–4 parallel agents ≈ 8–10 working days + 1 day soak + your review cycles. Critical path: Phase 0 → 1.1/1.4/1.6 → 2 → 4 → 8.

---

## 9. Verification strategy (the part that was missing)

| Layer | Basis | Scope | Isolation |
|---|---|---|---|
| Unit | `node:test` (no deps) | property parsers, zip reader/writer helpers, catalogue mappers, player/log parsers, metrics math, path validators | pure functions |
| Contract | handler map direct invocation | every 65 command: arg validation, DTO field names, error codes, not-found/conflict cases | temp data root |
| Service integration | real services + fake stdio/HTTP/clock | store concurrency/corruption, backups/restore/retention, worlds round-trip, content update, settings matrix, players fixtures, metrics history, migration fixture | temp data root, fixture HTTP server |
| UI E2E | real BrowserWindow + preload + `executeJavaScript` + `capturePage` | all tabs, Create wizard for 5 loaders, pipeline install success/failure/cancel + report card, settings save while running, quit, restart persistence | temp data root, screenshots as artifacts |
| Engine E2E | existing `--e2e` extended | real installs/boots per loader/pack route, cancel/failure injections | `.app-data` copy or temp root, serial |
| Soak/perf | long-running app | 24 h server + backups + metrics, console 10 MB, no leaks/orphans | disposable data root |

Gate runner (`scripts/verify.mjs`): clears `ELECTRON_RUN_AS_NODE`, kills/refuses concurrent instances, runs layers in order, uses temp roots, writes `artifacts/<timestamp>/` (logs, screenshots, data snapshots, timings), exits non-zero on any failure. Current four gates become layers inside it rather than standalone scripts.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Data loss while changing store/migration | Phase 0 backup tag + `.app-data` copy; migration dry-run, source untouched, marker, fixture test; no destructive migration without explicit confirmation |
| Live-network flakiness / provider change | Fixtures for every metadata shape; live E2E limited to a small matrix; clear `network required` tagging; retries only where safe |
| CurseForge policy/key instability | Keep keyless route B decision explicit (D9); key mode behind settings; no secrets in logs; policy documented |
| Create.tsx refactor regressions | Fix behaviour first with UI E2E; decomposition only after tests lock behaviour |
| Windows process semantics (trees, PID reuse, AV locks) | Fake-child integration tests + real smoke per phase; identity marker + CIM verification; tree kill |
| Scope expansion into full Rust transaction machinery | Map each staged/transaction row to a user-visible acceptance test; explicit deferrals approved (§11) |
| Long-running/parallel Electron tests interfering | Temp roots everywhere, single-instance guard in runner, serial gates, artifacts snapshot before/after |
| E2E mutating dev data | Runner uses copied/temp data root; `.app-data` snapshot restored afterwards |

---

## 11. Explicitly out of scope unless overruled

- RCON / live TPS via RCON — deferred by ADR-0011, no Rust implementation, `enable-rcon=false` on both sides.
- playit.gg orchestration, i18n, auto-update, full files editor, schedules beyond backups, roles/DBs/network/activity panels — listed as deferred in `docs/electron-port-plan.md`.
- NSIS/electron-builder packaging — deferred (D10); only the runtime-data build contract is fixed now.
- Rewriting the JSON store back to SQLite — the JSON choice is approved; we fix its durability/concurrency instead.
- Porting Rust unit tests 1:1 — the new cross-stack suite replaces them; Rust stays dormant reference.

If you want **true full Rust parity including RCON/readiness/ownership/transaction machinery**, say so and Phase 4/7 scope expands (adds ~1 week and needs the RCON security decision).

---

## 12. Approval checklist — reply with D1–D12 (or "recommended") and either

- **Approve Phase 0–1 first** (recommended): I tag/commit the baseline, build the harness, and fix the eight release blockers before any broader work; you review the diff and a screenshot evidence bundle, then we continue Phase 2–8. This gives you a safe, early checkpoint.
- **Approve the whole plan**: run all phases with the recommended decisions, with a review checkpoint after each phase.

Also confirm:
1. D1 data migration scope (import vs reset).
2. D2 zero-new-deps test harness (or allow vitest/playwright).
3. D12 Java 25 support vs hiding MC 26.x.
4. Whether `docs/audit/` + this plan should be committed as part of the baseline.

Once approved, the first action will be the baseline tag/commit (WP-0.1), then the test harness, then the P0 fixes — no product behaviour changes before those two safety steps.
