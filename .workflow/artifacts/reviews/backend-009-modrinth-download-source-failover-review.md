# Independent Review — Modrinth Download Source Failover

Date: 2026-10-09  
Task: `backend-009-modrinth-download-source-failover`

## Result

**PASS.** The source-selection change matches the scoped implementation guide, preserves the existing three-attempt ceiling, and keeps manifest hash verification as the placement gate.

## Findings checked

- Required-file parsing retains candidate URLs in manifest order only when each URL passes the existing HTTPS provider allowlist; an empty trusted list is rejected.
- Attempt selection rotates by attempt number through the nonempty URL list. One URL repeats as before; multiple URLs are tried within the existing three-attempt budget.
- SHA-1 and SHA-512 verification still occurs before placement. Failed attempts roll back progress and remove their `.part` file.
- The reviewed code keeps the existing redirect validation, curl/streaming size caps, cancellation/sibling-stop checks, four-worker limit, staging cleanup, and publication gates.
- The spec now distinguishes the disabled app-level `Content-Length` equality check from curl's advertised-size cap; it states that hashes decide acceptance for bodies within the cap.

## Verification limits

- No tests were added or run because the active agent instructions prohibit that without an explicit user request to test or verify implementation.
- Rust formatting checks were attempted but could not run: Rust tools failed while canonicalizing `H:\TESTMultiAI\20` with `Access is denied` (OS error 5).
- The screenshot did not include the selected `.mrpack` version, manifest, or install log, so it remains unknown whether the failing file lists alternate URLs. A live install was not run.
- Project files are untracked in this workspace, so no tracked baseline diff was available; review inspected the scoped source directly.
