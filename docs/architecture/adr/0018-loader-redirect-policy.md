# ADR-0018: Validate every loader redirect hop

**Status:** Accepted

## Context

The existing installer validates a trusted HTTPS starting URL, but `curl --location --proto-redir =https` follows any HTTPS redirect host. The new exact-loader pipeline downloads Mojang/Fabric/Forge/NeoForge metadata and installer artifacts; Forge and NeoForge installer JARs execute in staging. This decision covers loader metadata and artifact requests only. Modrinth provider API lookup uses the separate provider transport path and does not follow redirects; its executable-resolution policy remains a pipeline integration item.

## Decision

The new loader pipeline requests one redirect hop at a time. Before each request it requires HTTPS and a source-specific official-host allowlist match. It allows at most three redirects and stops with an actionable error on unapproved hosts or missing/ambiguous `Location` headers. Each loader metadata or artifact curl request uses the system-directory `curl.exe` and starts with `--disable` so executable search and a user's default curl config cannot bypass this policy. Do not execute an installer artifact after any unapproved redirect. Keep the existing legacy installer behavior unchanged until phase 7 migrates and removes its paths.

## Consequences

Redirect chains are checked before following each destination. A loader source redirect to a new CDN fails closed until that host is researched and explicitly added to the relevant allowlist. The loader adapter reuses curl as transport without automatic redirect following and adds no dependency. The provider API path remains distinct and must be revisited when the new pipeline is wired into the Create flow.
