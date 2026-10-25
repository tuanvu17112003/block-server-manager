# WORKFLOW_STATE

## Current Goal
Complete backend Phase 5 modpack discovery and installation: Modrinth-first, with CurseForge gated on application approval and acceptable terms, then a user-owned key if approved.

## Acceptance Criteria
- [x] Tauri search uses live Modrinth data by default; CurseForge remains disabled pending explicit API access/terms approval.
- [x] Pack cards, compatible versions, changelogs, and source-specific metadata are live for the enabled Modrinth provider.
- [x] Modrinth `.mrpack` installs resolve required server-side dependencies, validate inputs/downloads, and report cancellable progress; CurseForge manifests remain gated.
- [x] Modrinth installs work in one click and keep the client-only parity notice clear.
- [x] Browser mode retains its existing mock flow; Tauri never reports a mocked pack install as successful.
- [x] EULA, staging/publication, process-safety, and saved Quilt constraints remain intact.
- [x] Research, docs, independent review, tests, and regression checks pass; live curl/redirect/transfer-cancel integration coverage remains a documented non-blocking gap.

## Status
Phase: Done
Last updated: 2026-10-09
Owner: PQM
Active Task ID: backend-005

## Active Plan
1. DONE recover the roadmap: Phase 5 is Modpack sources; Phase 4 and UI-005 are archived as complete.
2. DONE map current Create/mock/IPC/backend extension points with CodeGraph and gather official Modrinth/CurseForge research.
3. DONE materialize Phase 5 research, proposed ADR, feature spec, and implementation checklist.
4. DONE implement and independently review Modrinth search/version discovery and Tauri Create wiring without new dependencies.
5. DONE materialize install-specific source findings, URL/ZIP constraints, and the Modrinth install IPC/resource contract.
6. DONE enforce the declared `.mrpack` size while streaming; polling-only attempt 1/3 was rejected and the streaming-cap attempt 2/3 passed review.
7. DEFERRED BY USER GATE: no CurseForge API or key-management implementation until explicit approval after the key requirements and terms review.
8. DONE independent review and final Rust/frontend regression gates for the authorized Modrinth slice; see the verification artifacts below.
9. DONE archive this completed Modrinth slice and reset the live dashboard while retaining the CurseForge gate.

## Recent Handoffs (last 3–5 only)
- 2026-10-09 PQM → Install-detail Scout: Modrinth download hosts, ZIP APIs, disk bounds, curl size behavior; DONE; see `docs/research/2026-10-09-modrinth-install-details.md` and `docs/research/2026-10-09-curl-stream-size-limit.md`.
- 2026-10-09 PQM → Modrinth Install Backend Implementer: cancellable staged install, hashes, path safeguards, EULA/properties merge; initial implementation DONE (25 Rust tests PASS).
- 2026-10-09 PQM → Modrinth Install UI Implementer: exact game/loader selection and install/cancel wiring; DONE; `npx tsc --noEmit` PASS.
- 2026-10-09 PQM → Independent Install Reviewer: attempt 1/3 rejected polling overflow checks; attempt 2/3 passed after output streaming was capped at the declared size.
- 2026-10-09 PQM → Modrinth Install Backend Implementer: strict streamed-byte cap and crossing-chunk test; DONE; `cargo fmt --check`, `cargo test --lib` (26/26), and `cargo check --lib` PASS.

## Decisions & Constraints (current only)
- Windows-first Tauri 2 + React/Vite; preserve browser mocks.
- Phase 5 follows `docs/implementation/backend-plan.md` §Phase 5: Modrinth-first, CurseForge key-gated.
- Do not report simulated pack installs as successful in Tauri; browser development keeps mock behavior.
- Do not auto-accept the Minecraft EULA; preserve staged validation/publication and process safety.
- Keep existing Quilt saved-server management/start behavior; do not expand standalone loader choices.
- CurseForge key issuance/terms and pack client-parity policy require official-source review before implementation.
- Official CurseForge terms create an unresolved eligibility/no-cache gate for this app; no CurseForge integration is enabled until the user confirms approval and terms interpretation.
- User approved `zip = 2.4.2` (default features off, `deflate` only) for Modrinth installation.
- User conditionally approved `keyring = 3.6.3` for CurseForge BYOK; defer its addition/use until the CurseForge API approval/terms gate clears.
- User explicitly instructed that CurseForge API access stays disabled until its key requirements/terms are reviewed and the user approves proceeding.
- No new dependencies without explicit user consent.

## Quality Gate Results (current task)
- CodeGraph: PASS for current pack UI/mock, installer job/publication, DB reference field, and Tauri command registration context; staleness warnings were recorded for files to re-read before edits.
- Research: PASS; official Modrinth and CurseForge primary sources reviewed.
- Docs gate: PASS; Phase 5 research, proposed ADR, spec, implementation guide, and indexes materialized.
- UI TypeScript: PASS (`npx tsc --noEmit`).
- UI production build: TypeScript passed; raw Vite build stops on existing host `EPERM` resolving `src/main.tsx`; the documented realpath fallback build passes.
- UI reviewer: PASS after rework; controls have accessible names and search is debounced with consistent pagination query.
- Backend reviewer: PASS after bounded 429 retries and redirect refusal on the Modrinth-only path.
- Backend reviewer: PASS after strict streaming-size-cap rework; review notes no end-to-end live curl, redirect-chain, or cancellation-during-transfer tests (non-blocking coverage caveat). Review report: `.workflow/artifacts/reviews/backend-005-modrinth-install-review.md`.
- Rust gates after attempt 2/3: `cargo fmt --check` PASS; `cargo test --lib` PASS, 26/26; `cargo check --lib` PASS. Two pre-existing dead-code warnings remain.
- Frontend after install integration: `npx tsc --noEmit` PASS; Vite fallback build PASS (48 modules); raw build still hits host `realpathSync.native` EPERM.
- Modrinth live API/install smoke: not performed.
- CurseForge API and key-management implementation remain gated by the user's explicit instruction; no `keyring` dependency was added.
- Install UI TypeScript: PASS after the scoped nullable-loader fix.
- Cargo resolved approved `zip` 2.4.2 and updated `Cargo.lock` using the approved toolchain escalation.
- Final verification summary: `.workflow/artifacts/test-logs/backend-005-modrinth-install-verification.md`.
