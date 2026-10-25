# Backend Phase 3 — Independent Review

Date: 2026-10-08
Reviewer: independent read-only review
Result: FAIL — rework attempt 1/3 required

## Findings

1. **[P2] Saved Java servers cannot start while Mojang is offline.** `start_live_server` resolves a configured path through `resolve_server_java`, which calls `validate_java_for_version` and fetches Mojang's version manifest and JSON. A network failure blocks launch even when a previously validated local runtime is present.
2. **[P2] Settings Java state can leak across server switches.** The active server change resets the settings draft and Java error but leaves candidate/busy/progress state and may let an in-flight operation update the newly displayed server's Java UI.
3. **[P3] Resume validation ignores the Content-Range unit.** The numeric start/end/total are checked, but the unit is discarded; require `bytes` before accepting the resumed response. Final size and SHA-256 checks remain in place.

## Verified areas

- Java commands and `servers_set_java_path` are registered; frontend Java IPC uses strict invokes.
- Candidate discovery checks `JAVA_HOME`, PATH, Windows registry, known install paths, and app-managed runtimes. Major version and architecture are validated.
- Installer checks free space, uses checksum-keyed partial files, verifies range metadata, expected package size, and SHA-256 before staged extraction and publication.
- Per-server Java paths persist and are checked before launch.
- Phase 2 EULA and start reservation protections remain present; browser mock paths remain.
- Progress listener is released in the frontend `finally` path.

## Limitations

- Reviewer did not run tests/builds; see `.workflow/artifacts/test-logs/backend-003-verification.md`.
- Windows end-to-end provisioning was not exercised on this host.

## Re-review after rework attempt 1

Date: 2026-10-08
Result: FAIL — the three findings above are resolved. One additional P2 remains:

- **[P2] Online Start can wait up to about 120 seconds for Mojang.** Requirement validation fetches both the version manifest and version JSON, each with a 60-second timeout, synchronously inside `server_start` before Java is spawned. A slow but successful network can leave Start in `starting` while holding the start reservation.

Other rework confirmations: known-version fallback applies only to network/5xx failures; HTTP 4xx, unknown versions, and explicit unsupported majors fail closed. Settings async handlers are guarded by server ID. `Content-Range` resume parsing now requires the `bytes` unit. Focused Rust tests cover the fallback and unit cases but remain unexecuted because Cargo is unavailable.

## Re-review after rework attempt 2

Date: 2026-10-08
Result: PASS, with two P3 follow-ups recorded below.

- Start uses a local Java requirement map for all seven current Create catalogue versions, performs local executable validation, and makes no Mojang requests. Unknown versions fail closed.
- The R1 fixes remain present.
- Follow-ups: the research note's fallback wording needed a clarification, and the local Start mapping lacked a direct test.

The research note now has a separately labeled implementation clarification. Rework attempt 3 added a direct unit test for all seven mappings and rejection of unknown versions/26.1. Final independent review is pending; Rust tests remain unavailable on this host.

## Final read-only check after rework attempt 3

Date: 2026-10-08
Result: FAIL pending a documentation wording decision.

- The direct unit test covers all seven current Create entries and rejects `1.22.1` and `26.1`; it remains unexecuted because Cargo is unavailable.
- The research clarification and the Java spec still imply that the metadata fallback is what enables offline Start. The implementation instead uses a separate local Start mapping; the fallback is used by Create/Settings metadata resolution.
- The reviewer confirmed that Start has no Mojang HTTP call and the current local mapping matches the Create catalogue.

The bounded rework allowance is exhausted (3/3); the user authorized one docs-only correction.

## Final review after the user-authorized docs correction

Date: 2026-10-08
Result: PASS.

The research clarification, Java spec, backend plan, and implementation plan now distinguish metadata fallback for Create/Settings requirement resolution from the local catalogue map used by Start. The user-authorized docs-only correction resolved the final P3 wording issue.

## Rust compiler follow-up

Date: 2026-10-08
Result: PASS for the minimal compile fixes.

The invalid Windows path strings now use nested `Path::join`, the process status update terminates its lock-result temporary before function exit, and the bounded reader no longer marks its parameter mutable. These changes preserve behavior. The compiler then passed the full test suite and `cargo check`.
