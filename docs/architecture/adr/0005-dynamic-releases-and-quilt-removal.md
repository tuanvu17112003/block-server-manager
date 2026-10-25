# ADR-0005: Dynamic Minecraft Releases and Quilt Creation Removal

- Status: Accepted
- Date: 2026-10-09
- Supersedes: the seven-version cap and Quilt new-server inclusion in ADR-0004's Phase 4 scope

## Context

The Create flow intersected Mojang releases with seven hardcoded IDs. That excluded valid releases despite Mojang and each loader provider already supplying dynamic metadata. The Java runtime gate stopped at 21 while the current Minecraft 26.1 release requires Java 25. Quilt's standalone installer flow failed in the user's environment and has high maintenance cost. New Server navigation also retained its wizard state while the global view stayed selected, and fixed sidebar/breakpoint assumptions cramped the content pane.

## Decision

- Use Mojang's official `type == release` catalogue as the Vanilla release source and let provider metadata determine Paper/Fabric/Forge/NeoForge compatibility.
- Support Temurin Java 8/17/21/25 for the currently available release requirements, with Mojang metadata authoritative and offline Start validation retained.
- Remove Quilt from new server discovery and installation.
- Keep the process-launch path for previously saved Quilt records to preserve existing server data and management.
- Give each New Server entry a fresh wizard identity and route saved-server sidebar selection through the shell.
- Make app-shell and Create content shrink and reflow at compact widths instead of relying on a fixed sidebar plus early multi-column layouts.

## Consequences

- The Vanilla list grows as Mojang publishes new official releases. Loader lists stay provider-specific and may be shorter.
- Adding a Minecraft release that requires a Java major beyond the app-supported set still requires a runtime update; unknown requirements fail clearly.
- Quilt install/discovery implementation is retired. Existing saved Quilt servers remain available only when their recorded launch files pass the current validation.
- The Phase 4 spec must no longer describe Quilt as a supported creation provider or treat seven releases as a compatibility boundary.
