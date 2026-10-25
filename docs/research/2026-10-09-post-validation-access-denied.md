# Post-validation Install Access Denied

Date: 2026-10-09

## Observed behavior

- The user’s native Tauri Vanilla install downloaded and validated the official server JAR, then returned `io error: Access is denied. (os error 5)` at 94% (`Validated`). No server appeared in the list.
- `server_install` calls `publish_installed_server` only after `prepare_install` returns success. The publication routine creates the server scaffold, appends `installer.log`, and renames the staging directory into `<app-data>/servers/<id>` before inserting the database row.
- The appended `installer.log` file handle remained in scope across the directory rename.

## Reproduction and conclusion

- A focused Rust probe on the same Windows host created a staged directory containing `server.jar` and `installer.log`. `std::fs::rename(staging, target)` failed with OS error 5 while the append handle was open, then succeeded after dropping the handle.
- This reproduces the screenshot failure and identifies the open append handle during publication as the cause. Close the handle before moving its containing directory.
- Rust documents that `std::fs::rename` uses `MoveFileExW` with a Windows fallback. `OpenOptionsExt` documents the default share mode as `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`, but the controlled directory-move probe still failed while that file handle remained open; explicitly dropping it before rename is required for this flow.
- Preserve the existing failure cleanup and publish-after-validation behavior. Do not add a blind retry or copy-and-delete fallback.

## Sources

- [Rust `std::fs::rename`](https://doc.rust-lang.org/stable/std/fs/fn.rename.html) — Windows implementation and failure conditions.
- [Rust Windows `OpenOptionsExt`](https://doc.rust-lang.org/stable/std/os/windows/fs/trait.OpenOptionsExt.html) — default file sharing flags.
- [Microsoft file security and access rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights) — permissions applicable to file and directory operations.
