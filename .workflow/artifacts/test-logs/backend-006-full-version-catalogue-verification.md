# Full Version Catalogue — Verification (final)

Date: 2026-10-09
Task: backend-006-full-version-catalogue
Scope: full catalogue backend + UI toggles after rework attempt 1.

## Rust

| Check | Result | Evidence |
|---|---|---|
| `cargo test --lib` (from `src-tauri`) | PASS | 41 passed, 0 failed (38 prior + 3 new; rewritten Paper envelope test passes). Covers Paper/Fabric/Forge/NeoForge/snapshot rules, suffix tolerance, ordering/labels, plus pre-existing installer/modpack/server/java regressions. |
| `cargo check --lib` | PASS | Exit 0; only the 2 known baseline dead-code warnings (`server_players_event`, `metrics_tick_event`). No new warnings. |
| `cargo fmt --check` | PASS | Clean. |

## Frontend

| Check | Result | Evidence |
|---|---|---|
| `npx tsc --noEmit` | PASS | Clean. |
| `npm run build` (Vite) | Skipped | Known host EPERM on H:; TS check suffices per prior records. |

## Review and limits

- Independent reviewer: PASS after one rework; see `../reviews/backend-006-full-version-catalogue-review.md`.
- No live provider smoke tests (offline unit tests only, by design); live curl/redirect/cancellation integration gaps carry over from prior phases.
- Known product notes: NeoForge prefix table covers 1.20.1/1.20.4/1.20.6/1.21 only (extend per documented mappings); snapshot Java detection needs network for unlisted IDs (clear error offline).
- `zip = 2.4.2` remains the only new direct dependency. No `keyring`, no CurseForge API access/UI.
