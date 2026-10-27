# Audit closure — finding status after the completion plan (Phase 8)

Status date: 2026-10-26. Every finding from `01-backend-runtime`, `02-frontend`, `03-installer`,
`04-management-content` was either fixed during Phases 1–7 (evidence in the phase logs of
[electron-completion-plan.md](../electron-completion-plan.md)) or is listed below as a tracked
known limitation. `05-parity-matrix.md` describes product parity and is not a bug list; its deferred
features are covered by the non-goals at the end of this page.

## Release blockers (must be closed for a usable app) — all fixed

| Finding | Fix | Phase |
|---|---|---|
| B-01 Paper install unimplemented | Paper Fill v3 branch in `installer/core.ts`, live build 133/232 verified, engine E2E Paper install/start/kill | 1/2 |
| B-02 quit orphans JVM | bounded `before-quit` shutdown + tree kill + `--quitsmoke` live proof (0 survivors) | 2/8 |
| B-07 corrupt store overwritten | read-through store, corrupt quarantine (`store-corrupt`), fsync+`bak`+unique tmp, row validation | 1 |
| B-09 partial server dir on failed install | staged install transaction: publish only after validation/boot verification; rollback | 2/4 |
| B-13 no legacy Tauri data migration | one-shot importer + startup hook + report/plan, unit-tested | 1 |
| INST-001 curated L4 data missing | bundled `installer/data/*.json` copied at build with contract gate; live `146 files · 22 unsupported` | 1/2 |
| INST-002 install reports complete without verification | boot-verified publish (`Done (` required before record) + report stages | 4 |
| INST-006 CF route-A blank metadata/guessed Java | inference from shipped installer (live SF5 `forge 1.20.1 47.4.0`) and fail-closed blank guard; no guessed Java major | 4 |
| F-01 install report crashes renderer | ErrorBoundary + full defensive report DTO | 1 |
| F-02 saving Settings stops running server | EULA-aware save; server only stops when consent actually changes | 5/6 |
| F-11 missing preload silently uses mocks | fail-closed bridge screen in Electron; browser mocks explicit dev flag only | 6/7 |
| M-01 content update leaves duplicate versions | replace-by-project transaction with trash/rollback, tests | 5 |
| M-17 corrupt ZIP restore/import crash | extractor/zip hardening (corrupt fixtures) + fail-closed validation | 1/5 |
| M-05 settings update not atomic (B-23/F-09) | validate-before-write with rollback | 2 |

## Backend runtime (`01`)

- **B-03 duplicate-start race** — fixed: per-server start reservation + `starting` set, stop-during-boot abort, serialized transitions (Phase 2 lifecycle suite).
- **B-04/B-05/B-17 crash-retry/stop-during-boot/kill status** — fixed: explicit `userStop`/intent, single crash event, kill→`stopped`, retry keeps log tail (Phase 2, lifecycle suite).
- **B-06 lost-update on pushCommand** — fixed: mutate-on-latest store, atomic writes; lost-update unit proof.
- **B-08 Java DTO `javapath` vs `path`/architectureBits** — fixed: `{path, architectureBits, major}` across backend/renderer (Phases 1/3/6).
- **B-10 spawn error hangs start** — fixed: `error` listener → `io` error + single settled promise (Phase 2).
- **B-11/B-12 loader catalogue/NeoForge** — fixed: full ADR-0007 catalogue, exact NeoForge mapping, validated pins (Phase 3, live matrix).
- **B-14 orphan reaping by image name** — fixed: identity marker `-Dtestmultiai.server.id`, CIM verification, fail-closed (Phase 2).
- **B-15 start requires Java validation, no metadata guess** — fixed: metadata-first mapping + inspected configured path; no Mojang wait on start (Phase 3).
- **B-16 stop hang / tree kill** — fixed: bounded stop, tree kill, `EXIT_STOP_BUDGET` semantics (Phase 2).
- **B-18/B-19 console contract/perf** — fixed: validated single-line commands, per-server 100 newest-first history + cascade, bounded async rotated tail (Phases 1/2).
- **B-20 EULA truth** — fixed: file+flag AND, `eula=false` wins, never auto-accepted (Phase 2).
- **B-21 job cancellation advisory** — fixed: AbortController signal threaded through downloads/extract/installer child trees; jobs cancel <2 s (Phase 4); Java provisioning itself is not abortable (tracked).
- **B-22 port model** — fixed: allocation/uniqueness/OS probe; start fails closed, no silent rewrite (Phase 2).
- **B-23 create/set-java validation** — fixed: normalizeCreateServerInput + allocation + DTO validation (Phase 2).
- **B-24 renderer hardening gaps** — fixed: strict CSP, navigation/window-open allowlists, permission deny-all, minimal preload, sender-frame + IPC arg validation (Phases 2/7).
- **B-25 gate integrity** — fixed: isolated temp roots per gate, boolean assertions, serial gate runner + this evidence set (Phase 0/8).
- **B-26 logging/diagnostics** — fixed: rotating launcher.log, JSONL timeline, redacting support bundle, crash handlers (Phase 7).
- **B-27/B-29 error-code/dead-code drift** — fixed: `{code,message}` envelope everywhere, renderer error helpers single-sourced, Tauri renderer path removed (Phases 1/6/7).
- **B-28 store durability details** — fixed: fsync, unique tmp, `.bak`, per-row validation, cascade delete (Phase 1).

## Frontend (`02`)

F-01…F-23 are all fixed in Phases 1 and 6 except the tracking notes below. Highlights: ErrorBoundary + defensive
report (F-01), silent `refreshServers`/patch-in-place (F-06), `activeId` reconciliation (F-08), request-safety
hooks (F-07), fail-closed preload screen (F-11), worlds export gating (F-12), Paper plugin lookup (F-13),
timestamp/metrics/TPS fixes (F-14/F-15), schedule rollback (F-16), Players/Backups spec affordances
(F-17/F-18), code-preserving toasts (F-19), port blocking + install re-check (F-20), **Create decomposition
2,503→392 lines/28 modules** (F-21), modal focus-trap/roles/labels (F-22), remaining minor spec gaps (F-23).
Mock/browser-mode-only branches are build-covered, not runtime-exercised (tracked).

## Installer (`03`)

INST-001…INST-023 are addressed across Phases 3/4 and verified by unit/service suites, the engine E2E and the
live matrix. Specific closures: transaction/rollback (INST-004), verified boot (INST-002), cancellation
(INST-003), archive hardening + protected manager paths (INST-005), source failover + cache re-hash
(INST-010), HTTPS per-hop allowlists (INST-011), CF staging hardening (INST-012), preview pin/drift guard +
single-use (INST-013), full plan/report DTO + sidecar (INST-014), overrides + reviewed include policy
(INST-015), L2/L3 managed-only policy (INST-007/016), Quilt rejection + loader coverage (INST-017), route B
validation (INST-018), limits (INST-019), progress fidelity (INST-020), runtime data bundled into the build
(INST-023).
Tracked: Fabric `depends.java` preflight is not implemented (Java is resolved from the MC mapping); old-Forge
arg/win_args launch parsing is partial; CF route-A extraction still relies on the transaction's manager-owned
config enforcement when a pack ships `eula.txt`/`server.properties`.

## Management/content (`04`)

M-01…M-23 are fixed in Phase 5 (see that phase log): atomic content update (M-01), idle-gated toggle (M-02),
schedule validation (M-03), retention pools (M-04), setting-save semantics (M-05), property maxPlayers (M-06),
content jobs/plugin deps (M-07), async world copy + progress (M-08), pending-world lifecycle (M-09), flush-ack
backup (M-10), atomic settings (M-11), EULA truth (M-12), batched core-normalized metrics + TPS (M-13), ZIP
writer hardening (M-14), UI/spec gaps (M-15), cascade delete (M-16), corrupt ZIP (M-17), delete-safety world
archive (M-18), world unit round-trip + NBT (M-19), ring-safe players (M-20), log formats + offline ops
(M-21), Java-escape properties (M-22), restore/reset semantics (M-23).
Tracked: world copy/export has no cancel; content rollback snapshot does not include mods/plugins (the
pre-update backup excludes them by spec).

## Known limitations / non-goals (honest)

- **Phase 8:** complete — the 24 h soak passed (24.01 h, 1,419 cycles, 0 handler errors, bounded memory,
  no JVM orphans; [summary](../evidence/soak-24h-summary.json)). One manual click-through of a full modpack
  install from the UI wizard remains a manual acceptance step (engine + UI DOM paths are covered). The soak's
  own post-window teardown exceeded its internal safety window and the harness process had to be terminated
  externally (no JVM remained); the production quit path is separately proven by `scripts/quitsmoke.mjs`.
- Packaging/installer (NSIS) deferred (D10); no auto-update, i18n, RCON (ADR-0011), playit.gg, full files
  browser, roles/database backends, schedules beyond backups, SQLite rewrite — per approved non-goals.
- The dormant `src-tauri/` tree is frozen reference; it is not built or shipped and may be archived/deleted
  after sign-off (ADR-0020).
- Renderer imports of `shared/contracts.ts` are still bridged by the contract gate's AST comparison (Electron
  tsconfig rootDir); the lists cannot drift without failing `--contracttest`.
- Mock/browser-mode UI branches and provider-outage retry branches are build-covered, not exercised in CI.
- CSP `connect-src` omits CDN hosts because the renderer never fetches them directly; add if renderer
  networking is introduced. Redaction is pattern-based (unlabeled random tokens are not guaranteed removed).
- Windows 0600 for the plaintext key fallback is best-effort (inherited per-user ACL).
