# Research — Prominence II Version for App Testing

Date: 2026-10-09  
Question: Which Prominence II Modrinth release should the user select to test the app after the Simply Swords Tweaks SHA1 failure?

## Recommendation

- **Targeted regression of the hash failure:** use **Prominence II 4.1.1hf**. Its official release notes say it fixes the Simply Swords Tweaks wrong hash, and its actual `.mrpack` manifest pins the official reupload `bZNBbmpH` with matching size and hashes.
- **General install test against the current release:** use **Prominence II 4.1.2**. It is newer, but its manifest and archive contain no `simply_swords_tweaks-fabric-2.0.0+1.20.1.jar` entry, so it will not exercise that file's hash-check path.
- **Reproduce the original failure:** use **4.1.1**. Its manifest has the stale single URL and expected SHA1 `1c1a4bb446bb4f6dae5312f53cfb1645fb4320df`; the URL currently returns different bytes. The earlier 4.1.0 manifest did not contain the failing path.

## Verified 4.1.1hf manifest entry

The official 4.1.1hf pack index contains:

- Path: `mods/simply_swords_tweaks-fabric-2.0.0+1.20.1.jar`
- URL: `https://cdn.modrinth.com/data/jZp8yNTq/versions/bZNBbmpH/simply_swords_tweaks-fabric-2.0.0%2B1.20.1.jar`
- `fileSize`: 57,679 bytes
- SHA-1: `b614077e97c9a4b840bdfa37abedf2cdb5852e2e`
- SHA-512: `0a26eeef02c694171ccce5f1985bc73784fb1dc2037d267d8d59979d53408a3e9069c4093b98570cf3c2294665abf6edc1ab8c7aa9374de6a4b97a27a9921f9c`

These match the official Modrinth API metadata and downloaded reupload bytes. The hotfix release page says it is fully compatible with 4.1.1.

## Sources

- Modrinth, [Prominence II 4.1.1hf](https://modrinth.com/modpack/prominence-2-fabric/version/pM4d8h1G) — explicitly says the Simply Swords Tweaks wrong hash is fixed.
- Modrinth, [Prominence II 4.1.2](https://modrinth.com/modpack/prominence-2-fabric/version/3uZ1MN34) — current general-test release.
- Modrinth, [Prominence II 4.1.1](https://modrinth.com/modpack/prominence-2-fabric/version/ZFZUTyJd) — stale manifest used for the original failure.
- Modrinth, [Simply Swords Tweaks 2.0.0 reupload](https://modrinth.com/mod/simply-swords-tweaks/version/bZNBbmpH) and [version metadata](https://api.modrinth.com/v2/version/bZNBbmpH) — corrected artifact identity.
- Modrinth, [`.mrpack` format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack) — download URL and hash contract.
