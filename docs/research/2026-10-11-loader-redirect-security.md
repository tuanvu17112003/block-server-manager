# Loader metadata and artifact redirect policy

## Finding

The legacy installer validates an initial loader URL and then invokes `curl.exe --location --proto-redir =https`. HTTPS-only redirects still allow a response to point at any HTTPS host. Curl's official manual documents that redirect targets can be inspected without automatic following through the `redirect_url` write-out variable; `--max-redirs` bounds redirects only when automatic following is enabled.

The new loader pipeline must not rely on automatic redirect following for metadata or artifacts. Request one hop at a time, validate every target as HTTPS and against the source-specific official-host allowlist before requesting it, and stop after three redirects. Curl reads a user default config file unless `--disable` is the first option; pipeline requests must pass that option first so a local config cannot re-enable automatic redirects or change the request. Resolve curl from the Windows system directory rather than by executable search name, and fail closed if the trusted system binary is unavailable. Keep this behavior in the new pipeline adapter so old installer callers are not silently changed during migration. If an official source redirects outside its reviewed allowlist, fail with the provider and target host; do not execute an installer fetched from an unapproved redirect.

## Sources

- [curl manual: redirect handling, `--max-redirs`, and `redirect_url`](https://curl.se/docs/manpage.html)
- [curl tutorial: disable default configuration with `-q` as the first parameter](https://curl.se/docs/tutorial.html)
- [Microsoft Learn: GetSystemDirectoryW](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getsystemdirectoryw)
- [Microsoft Learn: CreateFile sharing modes](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilea)
