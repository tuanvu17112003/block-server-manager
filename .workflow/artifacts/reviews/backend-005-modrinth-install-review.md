# Phase 5 Modrinth Installation — Independent Review

Date: 2026-10-09  
Scope: Modrinth `.mrpack` installation and its bounded download path.

## Result

**PASS** after the second scoped rework.

`stream_download_body` writes no more than the declared size. On a chunk that crosses the remaining allowance, it writes only the permitted prefix and signals overflow. The parent terminates and waits for curl, joins the body and stderr readers, removes the partial body/header artifacts, and returns a validation error. The limit no longer depends on the installed curl version.

Status and redirect decisions are read from the response headers. The reviewed HTTPS allowlists and three-redirect limit remain in place. The previously reviewed project/version ownership, hashes, safe ZIP paths, loader checks, exclusions, EULA, staging, rollback, browser mock, and no-CurseForge gates were unaffected.

## Coverage note

The focused test proves a crossing chunk leaves the destination at or below the cap and signals overflow. Tests do not run a live curl process or exercise a full redirect chain or cancellation during transfer. The reviewer considers this a coverage caveat, not a release blocker.

The initial polling-only fix was rejected because it allowed a write race. The second fix streams and caps accepted bytes and passed this review.
