# Open-Source Modpack Server Solutions — Project Review

Date: 2026-10-11  
Input: `H:\TESTMultiAI\24\research-handoff\research\2026-10-11-open-source-solutions.md` and its source register.

## Decision

Keep the current Windows desktop manager as the product layer. The reviewed alternatives do not provide a better drop-in for this app's CurseForge and Modrinth import, local server lifecycle, and safe publication requirements. Reuse implementation patterns from maintained projects; do not add a third-party installer dependency as part of this review.

## Findings applied

- `itzg/mc-image-helper` is the strongest maintained implementation reference in the survey for pack resolution and server-side selection, but its surrounding orchestration assumes Docker. Apply its reviewed policies where they match the app's existing fail-closed and exact-version behavior; do not bring over container assumptions.
- `nothub/mrpack-install` is a Modrinth-specific Go CLI with beta-only visible releases. It is useful as a format and update reference, not a native GUI or a verified dependency for this app.
- `packwiz`'s client/server/both side model is a useful policy reference. The app's current `.mrpack` behavior remains governed by its existing required/optional inclusion and `env.server=unsupported` exclusion rules.
- ServerPackCreator is a local-instance-to-server-pack generator with a different purpose and LGPL-2.1 obligations. Its metadata format is already recognized by this app for the narrowly validated Fabric import path.
- McPacker's AGPL-3.0 license, documented EULA auto-accept option, and continue-on-download-failure behavior conflict with the app's licensing and fail-closed constraints. Do not adopt it without a separate license and source audit.
- The survey found no mature Windows desktop alternative covering the target workflow. The broadest product alternative assumes Docker; the remaining tools have narrower scope, maturity, or policy gaps.

## App-specific correction

The current CurseForge import implementation accepts validated Forge and NeoForge archives and recognized ServerPackCreator Fabric archives, including one nested ZIP wrapper. Its historical feature spec and install guidance still described the initial allowlist as Forge/NeoForge only, and the Create wizard's install validation message repeated that outdated limit. Align the app message and implementation documents with the implemented support boundary. Do not imply that arbitrary Fabric archives, Quilt, client exports, or unverified layouts are supported.

## Sources

- [Open-source alternatives comparison in the research handoff](H:\TESTMultiAI\24\research-handoff\research\2026-10-11-open-source-solutions.md)
- [itzg/mc-image-helper](https://github.com/itzg/mc-image-helper)
- [nothub/mrpack-install](https://github.com/nothub/mrpack-install)
- [packwiz](https://github.com/packwiz/packwiz)
- [ServerPackCreator](https://github.com/Griefed/ServerPackCreator)
- [McPacker](https://github.com/littlepenguin66/mcpacker)
