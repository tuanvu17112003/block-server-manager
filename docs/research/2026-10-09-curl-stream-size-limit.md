# Research — curl In-Progress Download Limits

**Accessed:** 2026-10-09  
**Scope:** Safe Modrinth file downloads using the Windows system `curl.exe`.

## Finding

curl documents that `--max-filesize` / `CURLOPT_MAXFILESIZE` did not enforce a limit while an unknown-length transfer was in progress before curl 8.4.0. This app launches the system `curl.exe`, so its version varies by Windows host. The backend must enforce each provider-declared expected size itself while polling the partial file, terminate the child when the observed byte count exceeds the limit, remove partial files, and keep the existing final exact-size check.

This prevents an unknown-length or dishonest response from consuming disk until the network transfer completes even when the host curl is older than 8.4.0.

## Source

- [curl `CURLOPT_MAXFILESIZE` documentation](https://curl.se/libcurl/c/CURLOPT_MAXFILESIZE.html)
- [curl 8.4.0 changes](https://curl.se/ch/8.4.0.html)
