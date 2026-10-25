# Research — Modrinth Install Details

**Accessed:** 2026-10-09  
**Scope:** Phase 5 Modrinth `.mrpack` server installation, redirect policy, archive handling, and resource bounds.

## Provider download hosts

- Modrinth's `.mrpack` specification requires HTTPS download URLs and identifies `cdn.modrinth.com`, `github.com`, `raw.githubusercontent.com`, and `gitlab.com` as the hosts accepted for Modrinth uploads. The application uses those exact hosts for direct manifest downloads.
- GitHub documents `github-releases.githubusercontent.com` and `objects.githubusercontent.com` under its `githubusercontent.com` release/action download host family, and also uses `release-assets.githubusercontent.com`. These exact GitHub-owned domains are allowed as redirect-only hosts; no wildcard host matching is used.
- The installer disables automatic curl redirect following. It reads one `Location` at a time, resolves only absolute HTTPS locations, checks each hop against the provider's exact allowlist, and stops after three redirects. Unsupported/relative redirect targets fail with a visible error. Modrinth metadata endpoints never follow redirects.
- For Modrinth API 429 responses, the service parses `X-Ratelimit-Remaining` and `X-Ratelimit-Reset` (seconds until reset), waits at most 30 seconds per attempt, and retries at most twice. The catalog's request path stays cancellable only inside install jobs; catalog read calls remain bounded by the HTTP timeout.

## ZIP handling

- The approved `zip` 2.4.2 implementation provides `ZipArchive::by_index`, `ZipFile::enclosed_name`, `ZipFile::size`, and `ZipFile::is_symlink`. Its general-purpose `ZipArchive::extract` can create symlinks, so the server installer uses a manual file-by-file path that rejects symlinks and validates each entry before creating it.
- Use streaming reads into staged files; never load the entire expanded archive into RAM. Recheck the total expanded size with checked arithmetic while extracting, even when central-directory size metadata is available.
- Project-selected bounds: maximum `.mrpack` compressed size 2 GiB, 100,000 archive entries, and 20 GiB total expanded bytes. Check free space on the staging volume for the archive, required downloads, expansion, base installer, and 512 MiB headroom. These are application safety limits, not Modrinth format limits.
- The existing Windows `GetDiskFreeSpaceExW` helper can supply available bytes for the staging volume. Other builds retain the project's Windows-first platform policy and fail clearly if the disk check is unavailable.

## Install interpretation

- The project version endpoint provides the pack `.mrpack` file metadata. The backend fetches the exact version ID again and confirms the returned `project_id` matches the selected project ID.
- `modrinth.index.json` is the authority for exact Minecraft, loader, file paths, file sizes, and SHA-1/SHA-512 hashes. Supported new-server loader dependencies are Vanilla (`minecraft` or absent), Fabric, Forge, and NeoForge. Quilt and unknown dependencies fail closed.
- Install only files whose `env.server` value is `required`. Skip optional, unsupported, client-only, and missing-environment files, and show a client-parity notice/log count.
- Shared `overrides/` then `server-overrides/` are applied after the base server install. `client-overrides/` is ignored. The manager controls EULA acceptance and server network identity fields; pack overrides cannot change the selected port, manager MOTD, or EULA decision.

## Sources

- [Modrinth API overview and rate-limit headers](https://docs.modrinth.com/api/)
- [Modrinth `.mrpack` format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack)
- [GitHub release asset download behavior](https://docs.github.com/en/rest/releases/assets)
- [GitHub download host allowlist](https://docs.github.com/en/enterprise-cloud%40latest/code-security/reference/supply-chain-security/automatic-dependency-submission)
- [`zip` 2.4.2 source: `ZipArchive` reader and extraction behavior](https://raw.githubusercontent.com/zip-rs/zip2/v2.4.2/src/read.rs)
- [`zip` 2.4.2 manifest / MSRV](https://raw.githubusercontent.com/zip-rs/zip2/v2.4.2/Cargo.toml)
- [Windows `GetDiskFreeSpaceExW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdiskfreespaceexw)
