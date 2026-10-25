# Independent Review — Modrinth Download Reliability

Date: 2026-10-09  
Task: `backend-007-modpack-download-reliability`

## Review result

**PASS after two scoped rework attempts.** The reviewer did not edit files.

### Initial finding — FAIL

- **Major:** A same-Minecraft pack-version switch during an active loader request canceled the old effect's state update and launched another provider request after the debounce.

### Rework attempt 1 — finding narrowed

- Added a per-Minecraft in-flight promise map so new effects subscribe to the existing request. The re-review confirmed duplicate in-flight requests were prevented, but found that one resolved cache entry could be overwritten by an out-of-order response for a different Minecraft version.

### Rework attempt 2 — PASS

- Changed resolved choices to a map keyed by Minecraft version while retaining the in-flight promise map. The reviewer confirmed same-Minecraft changes reuse pending and completed results; out-of-order results remain isolated by version; canceled effects cannot update visible choices, selected version ID, error, or loading state.

## Other reviewed criteria

- Required-file download, exact-size, SHA-1, and SHA-512 failures retry up to three total attempts with fresh `.part` files and bounded backoff. Exhaustion reports path, attempt count, and the original failure.
- Cancellation and redirect-policy errors are terminal. Content-Length is checked only when one parseable value is present in the complete final 2xx response block; mismatches abort and retry. Missing or ambiguous lengths still reach exact-size/hash verification.
- HTTPS allowlist, three-redirect cap, header cap, streaming size cap, curl max-filesize, staging, publication, and install-time fresh provider validation remain intact.
- Curl connect, low-speed, and total transfer timeouts remain present. Progress polling is coarser and periodic log flushes were removed.
- New-install Quilt rejection and the CurseForge-disabled gate remain intact; no dependency was added.

## Coverage limitation

Static review only. No live curl transfer, redirect-chain, or cancellation-during-transfer smoke test was run; the existing spec records these as integration coverage gaps.
