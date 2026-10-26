# Electron migration completion — summary report (for approval)

**Date:** 2026-10-26 · **Workspace:** `H:\TESTMultiAI\20` · **Status:** analysis complete, implementation not started
**Full plan:** [docs/electron-completion-plan.md](electron-completion-plan.md) · **Evidence:** [docs/audit/evidence.md](audit/evidence.md) · **Detailed findings:** [docs/audit/](audit/01-backend-runtime.md)

---

## 1. Bottom line

The Electron port boots and its demo path works, but it is **not complete or reliable**. The five existing gates are green (build, selftest, mgmttest 17/17, ipctest, e2e 12/12) while **8 release-blocking defects** and ~30 high-severity defects remain reachable from normal user flows. The gates are happy-path, backend-only, and mutate the dev data root, so they cannot detect these failures.

- **8 P0 blockers** · **~33 P1** · ~55 P2/P3 · **98 findings** total (deduped across five audits).
- Tauri parity: 35 commands = **6 OK / 21 PARTIAL / 8 BROKEN / 0 missing**; Electron adds 30 new commands (management/content).
- Management/content tabs are **new functionality** (Rust modules were empty stubs) and are hardening-poor: 1 P0 + 5 P1, mgmttest covers happy paths only.
- **No product code has been changed.** Fixes require approval of the plan and 12 decisions.

## 2. Verified baseline (2026-10-26)

| Gate | Result |
|---|---|
| `npm run build` (electron tsc + renderer tsc + vite) | PASS |
| `npm run selftest` | PASS, but tests phase-0 handlers only and cannot fail on string verdicts |
| `npm run mgmttest` | PASS 17/17 happy-path service checks |
| `npm run ipctest` (real preload/renderer chain) | PASS |
| `electron . --e2e` | PASS 12/12 (Vanilla, Modrinth cobbleverse, CF SkyFactory-5 key-mode, zip inspect) |
| Independent UI probe (real renderer + IPC, temp root) | all 8 tabs + Create Configure render, no renderer errors |
| Command wiring | 65 Electron handlers ↔ 65 renderer invocations ↔ all 35 Rust names present |

Environment note: the shell inherits `ELECTRON_RUN_AS_NODE=1`, which makes `electron .` run as plain Node and breaks every gate until cleared. The new gate runner will clear it and refuse concurrent instances.

## 3. Release blockers (P0)

1. **Paper server creation is impossible** — no `paper` branch in `installLoader`; live repro: `loader not supported: paper`, while the UI advertises Paper.
2. **Create screen blanks after any modpack install** — backend install report omits `loader/planId`; the renderer dereferences `report.loader.minecraftVersion`; no ErrorBoundary.
3. **Quit leaves servers running** — `before-quit` fires `void shutdown()` and exits; no bounded stop/tree kill → orphaned `java`, unsaved worlds.
4. **Store can lose or wipe data** — `pushCommand()` writes a stale snapshot (reproduced: newly created server disappeared); a corrupt `app-data.json` becomes an empty store and the next write destroys it.
5. **No Tauri→Electron data migration** — different data roots; existing `app.db` and server folders are ignored → empty list after upgrade.
6. **Advertised 4-layer client-mod defense ships as 3 layers** — curated `installer/data/*.json` is never copied into the build; per-pack keys use project ids instead of slugs; learned-file write crashes Start.
7. **Install reports success without a verified start** — pipeline never validates launch shape or reaches `Done (`.
8. **Corrupt/truncated backup or world ZIP crashes/hangs the app** — uncaught `Z_DATA_ERROR` in the shared extractor, promise never settles (probe-reproduced).

## 4. High-severity themes (P1)

- **Lifecycle:** kill reports `crashed`; duplicate-start race; crash-retry loses log tail and spams crash events; unhandled spawn error; stop/quit hangs; orphan reaping trusts image name only (no identity marker).
- **Contracts:** Java `javapath` vs renderer `path` breaks display/override; pipeline report/plan DTO incomplete; CF staged timestamp ms vs s; promised install log/bytes/`install-report.json` absent.
- **Catalogue/Java:** NeoForge missing for 1.20.2–1.21.x + wrong URL; Paper version/channel mislabelled; Java 25 vs exposed MC 26.x; detection lacks arch/timeout/arbitrary-path validation; no Adoptium SHA-256.
- **Installs:** non-atomic final-dir installs, record-before-validation; cancellation decorative; archive can accept EULA/overwrite manager paths; CF route A blank MC/loader + guessed Java; L3 injects Modrinth jars into CF/user servers; no failover/cache re-verify; no host/redirect allowlist.
- **Management:** content update leaves old jar (duplicate mods); settings save silently stops running server; world-delete backup archives the wrong world; export→import broken/dimensions lost; `players_list` loses online players at ring saturation; restore `reset` does not reset.
- **Frontend/security:** Create has no recovery from catalogue/Java failure and can trap first-run; every mutation flashes the whole shell; stale `activeId`; no CSP/navigation/sender checks; unvalidated `openExternal`; no id/path validation across handlers.

## 5. Root causes

1. Ported by command name, not by contract (payloads/validation/errors/semantics drift).
2. No shared types or runtime validation at the IPC boundary.
3. No staging/transaction discipline outside the pipeline.
4. Ad-hoc async ownership (fire-and-forget shutdown, no lifecycle queue, unlocked JSON writes).
5. Demo-based verification (gates miss UI render, negative paths, second instance, corrupt data).
6. Provider catalogues simplified instead of ported per ADR-0007/0014/0018.
7. Build packaging gap (runtime data absent), no storage-migration design.
8. Legacy Tauri/HTTP/mock surfaces kept alive; docs claimed completion early.

## 6. Plan at a glance (9 phases)

| Phase | Duration | Scope | Exit gate |
|---|---|---|---|
| 0 — Safety net | 1–1.5 d | Tag/commit baseline, `.app-data` backup, zero-dep test harness (`node:test` + Electron UI harness), gate runner (temp roots, serial, screenshots), shared contract skeleton, docs truth pass | `npm run verify` green from clean state; rollback tag |
| 1 — Release blockers | 3–4 d | Store durability/serialization; Paper install; pipeline report + ErrorBoundary; shutdown lifecycle; kill/spawn semantics; legacy data import; bundle curated data; extractor hardening | All 8 blocker repros + extended E2E green |
| 2 — Lifecycle & process | 2–3 d | Start reservation/queue; identity marker + CIM reap + tree kill; port model; staging/atomic publish; EULA authority; console contract; IPC validation layer | 50-cycle stress leaves no orphan/dirty status |
| 3 — Catalogue & Java | 2–3 d | Full provider catalogues (Paper builds, Fabric/Forge/NeoForge incl. legacy mapping, snapshot policy); Java parity (majors 8/17/21/25, arch, SHA-256, lock, arbitrary-path validate); fast start + readiness events | Loader matrix live; Java matrix offline; one server per loader |
| 4 — Installer parity | 4–5 d | Real cancellation; 4-layer defense correct; verified install; failover/hash/allowlist; route A/B metadata + full reports; optional/overrides parity; CF staging hardening; Quilt policy | Reference parity matrix re-run; cancel in seconds; broken pack fails |
| 5 — Management/content | 2–3 d | Content update/toggle/jobs/plugin deps; backup retention/flush/scheduler; worlds delete/export/import/reset/level.dat; settings atomicity/EULA/properties escapes; players log formats/ring/offline; metrics batching/CPU/TPS | Service integration suite + mgmttest ≥80 checks |
| 6 — Frontend | 2–3 d | ErrorBoundary/toasts/retry; shell/store state (no full reload flash, activeId); Settings/Create/Java flows; tab spec alignment; decompose Create.tsx; remove dead mock paths | UI E2E walks all tabs/flows with screenshots |
| 7 — Architecture/security | 2–3 d | Enforce shared contracts; retire/archive Tauri + stale HTTP export per decisions; CSP/navigation/window-open/openExternal hardening; rotating file logs; docs/ADR/repo hygiene | No duplicated contracts; no dead prod paths; docs match code |
| 8 — Verification/release | 2–3 d + 24 h soak | Unit + contract (all 65 commands) + service integration + real-UI E2E + install matrix (5 loaders × provider routes) + non-functional gates + manual walkthrough | `npm run verify` green, matrix green, soak clean, screenshots accepted |

**Effort:** ~30–38 engineer-days; with 3–4 parallel agents ≈ 8–10 working days + 1 day soak + review cycles.
**Critical path:** Phase 0 → 1 (store, shutdown, migration) → 2 → 4 → 8.

## 7. Verification strategy (what was missing)

- **Unit:** pure helpers (properties, zip, catalogues, log/player parsers, metrics math, path validators) via built-in `node:test` (no new dependencies by default).
- **Contract:** every command through the handler map — arg validation, DTO field names, error codes, not-found/conflict cases.
- **Service integration:** store concurrency/corruption, backups/restore/retention, corrupt ZIP, world round-trip/reset, content update, settings matrix, ring-saturated players, metrics history, migration fixture.
- **Real-UI E2E:** BrowserWindow + real preload + `executeJavaScript` + `capturePage`: all tabs, Create for 5 loaders, Modrinth/CF install success/failure/cancel with report card, settings save while running, quit, restart persistence, legacy import.
- **Engine/install matrix:** real installs/boots per loader and pack route, failure/cancel injections, legacy Java 8 pack, Unicode path.
- **Non-functional:** 10 MB console tail <100 ms, 24 h soak (server + auto-backup + metrics) with no leaks/orphans and bounded growth.
- **Gate runner:** clears `ELECTRON_RUN_AS_NODE`, refuses concurrent instances, uses temp roots, writes timestamped artifacts (logs/screenshots/data snapshots) and fails loudly.

## 8. Decisions required

| # | Decision | Recommendation |
|---|---|---|
| D1 | Import legacy Tauri `app.db` + server folders vs reset | **Import** one-shot (node:sqlite), dry-run, source untouched |
| D2 | Add test dependencies (vitest/playwright) vs zero-dep harness | **Zero-dep first** (`node:test` + Electron UI harness) |
| D3 | Implement Paper + all NeoForge families, or hide them | **Implement**; reject Quilt server-side (ADR-0005) |
| D4 | Commit current WIP wave + tag baseline before fixes | **Yes** (required by backup-before-refactor rule) |
| D5 | Tauri dormant code | Keep as reference, archive/remove in Phase 7 |
| D6 | HTTP/web-export target | Retire stale export; mocks only behind explicit dev flag |
| D7 | Quit with running servers | Auto stop, 5 s budget + tree kill ("stopping servers…") |
| D8 | `server_start` contract | Fast ack + `server://readiness/{id}` events |
| D9 | Defense-layer & dependency policy | Verified install + boot L2/L3 for managed installs; Modrinth fetch; CF prune-only |
| D10 | Packaging (electron-builder/NSIS) | Defer, but add build-contract check for runtime data |
| D11 | CurseForge key UX | Settings + OS `safeStorage`, file fallback, rotation without restart |
| D12 | Java 25 / MC 26.x | Support Java 25 (majors 8/17/21/25) or hide 26.x |

## 9. Top risks

1. Data loss while changing store/migration → tag + backups, dry-run, source untouched, fixture test.
2. Live-network/provider flakiness → fixtures for metadata, small live matrix only.
3. Scope creep into full Rust transaction machinery → map each item to a user-visible acceptance test; explicit deferrals.
4. Create.tsx refactor regressions → fix behaviour first, tests lock it, decompose after.
5. Windows process/PID semantics → fake-child tests + identity marker + real smoke per phase.

## 10. Out of scope (unless overruled)

RCON (ADR-0011), playit.gg, i18n, auto-update, full files editor, schedules beyond backups, roles/DBs/network/activity panels, NSIS packaging, SQLite rewrite, 1:1 Rust test port. Rust parity expansions need explicit approval (~+1 week).

## 11. Recommendation

Approve **Phase 0–1 first**: baseline tag/commit + test harness + all 8 blockers, delivered with diff and screenshot evidence for your review, then continue Phase 2–8. No product behaviour changes happen before the safety net exists.

**To start, reply with D1–D12 ("recommended" is acceptable) and either "approve Phase 0–1" or "approve all phases".**
