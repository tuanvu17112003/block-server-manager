# WORKFLOW_STATE

## Current Goal
Implement backend Phase 2 Process manager (spawn java, PID tracking, start/stop/kill/restart, log streaming, stop-all on exit).

## Acceptance Criteria
- [x] Backend process lifecycle: java spawn/PID tracking, graceful stop/kill/restart, crash status/log events/stdin commands, stop-all, fail-closed stale PID reaping
- [x] Entry fixes: EULA DB/file sync and start refusal, MOTD name validation, strict toastable Tauri errors
- [x] Tauri store uses persisted server IDs, retryable list error, first-run Create completion; browser mocks and UI gates preserved
- [x] TypeScript check passed; Vite build passed using a temporary Node JS realpath fallback because this host's native realpath on H: returns EPERM; Rust toolchain absent and reported
- [x] Bindings kept: EULA never auto-accepted, RCON 127.0.0.1 only, no secrets in binary, no Mojang assets

## Status
Phase: Done
Last updated: 2026-10-08
Owner: PQM
Active Task ID: none

## Active Plan
1. DONE backend-002 Phase 2 Implementer (process.rs + cmds + entry fixes + store wiring; npm build clean; cargo check NOT run - toolchain missing)
2. FAIL Reviewer gate: duplicate-start tracking race; unsafe Windows orphan PID fallback; Tauri server IDs remain mock-only; Windows descendant cleanup and lockfile write failure also flagged
3. FAIL Tester gate: `npx tsc --noEmit` PASS; `npm run build` blocked by Node/Vite `EPERM` from `fs.realpathSync.native` on `src/main.tsx`; `cargo`/`rustc` unavailable; no lint/test scripts configured
4. DONE Explorer research + docs materialization (`docs/research/2026-10-08-phase2-process-safety.md`; backend plan/checklist updated)
5. DONE Scoped rework attempt 1/3: start reservation, fail-closed CIM identity, process-tree termination, lockfile cleanup, Tauri persisted list/create + empty-database flow
6. DONE Independent post-rework Tester: `npx tsc --noEmit` PASS; `npm run build` still blocked by Node native realpath EPERM; Rust toolchain unavailable
7. FAIL Independent Reviewer gate: prior five findings resolved; one P2 fresh-database Create completion state is unmounted after first Tauri record is added
8. DONE React state research + docs materialization (`docs/research/2026-10-08-phase2-create-flow.md`; app-tabs spec/backend checklist updated)
9. DONE Scoped rework attempt 2/3: confirmed list hydration separates existing-server loading from first-run Create mode; first-run view persists through first record until Go to Console
10. DONE Independent post-R2 Tester: `npx tsc --noEmit` PASS; `npm run build` blocked by same Node/Vite realpath EPERM; Rust toolchain unavailable
11. FAIL Independent Reviewer gate: R2 Create completion passes; P2 rejected server-list load stays on Loading indefinitely and has no retry
12. DONE React external-system research + docs materialization (`docs/research/2026-10-08-phase2-list-error.md`; backend plan/checklist updated)
13. DONE Scoped rework attempt 3/3: strict list-load errors now render a retryable error view; retry uses strict `servers_list`
14. DONE Independent final Tester: `npx tsc --noEmit` PASS; Vite build passes with temporary Node JS realpath fallback; Rust toolchain unavailable
15. DONE Independent final Reviewer PASS; no remaining code findings
16. DONE Archive this completed goal and reset live state

## Recent Handoffs (last 3–5 only)
### 2026-10-08 PQM → Implementer git-bloat-002
Task: ignore vendored skills (user-approved) | Result: DONE - .gitignore 29→32 lines; status 252→77, skills on disk intact | Files: .gitignore only
### 2026-10-08 PQM → Implementer backend-002
Task: Phase 2 process manager + entry-criteria fixes | Result: DONE - async lifecycle cmds + log pumps + stop-all + orphan reap + 3 entry fixes + store Tauri/browser split; npm build clean 4.6s; cargo MISSING toolchain | Files: src-tauri/**/process.rs+cmds, src/tauri.ts, src/store.tsx
### 2026-10-08 PQM → Reviewer + Tester backend-002
Task: Independent Phase 2 gates | Result: FAIL - reviewer found 3 P1 + 2 P2 findings; TypeScript PASS, Vite build EPERM in native realpath, Rust toolchain unavailable | Files: read-only review/verification
### 2026-10-08 PQM → Explorer backend-002-R1
Task: Research safe PID verification, Windows child cleanup, and process reservation | Result: DONE - official Microsoft/Rust docs reviewed; recommendations materialized before code | Files: docs/research/2026-10-08-phase2-process-safety.md, docs/implementation/backend-plan.md, checklist.md
### 2026-10-08 PQM → Implementer backend-002-R1
Task: Scoped rework for 3 P1 + 2 P2 findings | Result: DONE - implementation reports five fixes; `npx tsc --noEmit` PASS; build/Cargo limitations persist | Files: src-tauri/src/servers/process.rs, src/tauri.ts, src/store.tsx, src/tabs/Create.tsx, src/App.tsx
### 2026-10-08 PQM → Tester backend-002-R1
Task: Independent post-rework verification | Result: DONE - `npx tsc --noEmit` PASS; Vite build blocked by the same Node native realpath EPERM; Rust toolchain unavailable | Artifact: `.workflow/artifacts/test-logs/backend-002-verification.md`
### 2026-10-08 PQM → Reviewer backend-002-R1
Task: Independent review after first rework | Result: FAIL - five original findings appear resolved; P2 first-server Create completion disappears when the empty-list view unmounts | Artifact: `.workflow/artifacts/reviews/backend-002-R1-review.md`
### 2026-10-08 PQM → Explorer backend-002-R2
Task: Research React first-server Create state preservation | Result: DONE - official React docs confirm unmount destroys component state; docs/spec/checklist updated before code | Files: docs/research/2026-10-08-phase2-create-flow.md, docs/specs/app-tabs.md, docs/implementation/backend-plan.md, checklist.md
### 2026-10-08 PQM → Implementer backend-002-R2
Task: Keep fresh-database Create completion mounted | Result: DONE - store now exposes hydration state; App waits to choose first-run vs existing-server route; `npx tsc --noEmit` PASS; build host limitation persists | Files: src/store.tsx, src/App.tsx
### 2026-10-08 PQM → Tester backend-002-R2
Task: Independent verification after Create-flow rework | Result: DONE - `npx tsc --noEmit` PASS; Vite build blocked by same native realpath EPERM; Rust toolchain unavailable | Artifact: `.workflow/artifacts/test-logs/backend-002-verification.md`
### 2026-10-08 PQM → Reviewer backend-002-R2
Task: Independent review after second rework | Result: FAIL - Create completion now persists; P2 server-list rejection leaves a permanent Loading view without Retry | Artifact: `.workflow/artifacts/reviews/backend-002-R2-review.md`
### 2026-10-08 PQM → Explorer backend-002-R3
Task: Research server-list error state/retry | Result: DONE - official React Effects docs reviewed; retryable error acceptance materialized before code | Files: docs/research/2026-10-08-phase2-list-error.md, docs/implementation/backend-plan.md, checklist.md
### 2026-10-08 PQM → Implementer backend-002-R3
Task: Add retryable Tauri server-list error state | Result: DONE - load failure is distinct from empty DB; explicit retry invokes strict list command; TypeScript PASS; build host limitation persists | Files: src/store.tsx, src/App.tsx
### 2026-10-08 PQM → Tester backend-002-R3
Task: Independent final verification | Result: DONE - `npx tsc --noEmit` PASS; raw Vite invocation hit native realpath EPERM; host-shimmed build passed; Rust toolchain unavailable | Artifact: `.workflow/artifacts/test-logs/backend-002-verification.md`
### 2026-10-08 PQM → Reviewer backend-002-R3
Task: Independent final review after three scoped reworks | Result: PASS - no remaining code findings; documented narrow PID-reuse race remains | Artifact: `.workflow/artifacts/reviews/backend-002-R3-review.md`

## Decisions & Constraints (current only)
- Style goal: FULL Minecraft look, whole app (shell + 7 tabs + Create), pixel font headings/buttons only, body/logs stay clean
- Graphics: pure CSS only (gradients, borders, shadows; no image files); NEVER Mojang assets/logo/fonts - original work only
- Font must be OFL-licensed (e.g. Press Start 2P via fontsource); verify before bundling
- Platform: Desktop Windows-first; Stack: Tauri 2 + React Vite + Tailwind + shadcn-style (ADR-0002, fallback Electron)
- 7 per-server tabs + global Create (layout-001); EULA+RAM gates mandatory, warnings must stay readable
- Follow WORKFLOW.md + AGENTS.md (research-before-code, docs-tree before code, stop on deviation)
- Backend-001 DONE: src-tauri/ + SQLite Phase 0+1; Rust UNVERIFIED (install MSVC toolchain + rerun cargo check/clippy/fmt before Phase 2)
- Phase 2 entry criteria: fix EULA file/DB divergence (scaffold writes false even when accepted) + MOTD property injection (reject \n\r= in name); replace invokeOrStub swallow with error toasts when store wired
- Git hygiene: root .gitignore 32 lines (node_modules, dist, .codegraph, src-tauri/target+gen, .opencode/node_modules, skills/, logs); vendored .opencode/skills/ stays on disk untracked (user-approved 2026-10-08); first commit will be ~10k lines not 95k

## Quality Gate Results (current task)
- Reviewer: PASS after rework 3; see `.workflow/artifacts/reviews/backend-002-R3-review.md`
- Tests (incl. regression): `npx tsc --noEmit` PASS; `npm run build` PASS with a temporary external Node JS realpath fallback shim; unmodified invocation reports host `EPERM`; `cargo check` unavailable (cargo/rustc missing)
- Lint: no configured npm lint script; Rust clippy/fmt unavailable without toolchain
- Rework attempts: 3/3 (complete)
