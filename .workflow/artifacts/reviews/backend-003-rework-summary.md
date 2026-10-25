# Backend Phase 3 — Rework Escalation

Date: 2026-10-08
Task: `backend-003`
Gate: final documentation review
Rework limit: 3/3 attempts used

## Completed attempts

1. Fixed online-only validation for known versions, Settings Java state leakage across server switches, and Content-Range unit validation; added focused Rust tests.
2. Removed Mojang HTTP from server Start by using a local mapping for the seven current Create catalogue versions; documented the local Start behavior.
3. Added a direct unit test for all seven Start mappings and rejection of unknown/26.1; appended an implementation clarification to the research note.

## Resolved finding

The final independent check found a P3 wording mismatch. The research clarification and Java spec could be read as saying the metadata fallback enables offline Start. The implementation uses a separate local Start map; the metadata fallback applies to Create/Settings requirement resolution. The user authorized one docs-only correction, which made the distinction explicit.

The reviewer verified the local map matches `MC_VERSIONS`, and the new test covers all entries, but Cargo is unavailable, so the test has not run. TypeScript passes; Vite build passes with the documented temporary external realpath shim; native build reports the existing host `EPERM`.

## User decision

The user authorized one additional docs-only correction after the 3/3 cap. The research note and spec now distinguish the metadata fallback used in Create/Settings from the local Java mapping used by Start. Final read-only review passed. Cargo remains unavailable, so Rust tests remain unexecuted.
