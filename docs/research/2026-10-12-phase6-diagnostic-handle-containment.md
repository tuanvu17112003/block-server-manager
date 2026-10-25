# Phase 6 Historical Diagnostic Handle Containment Follow-up

Date: 2026-10-12
Task: `modpack-server-setup-overhaul`

## Review Finding

The startup-failure diagnostic reader validates `latest.log` and crash-report paths, then opens each path separately. On Windows, `FILE_FLAG_OPEN_REPARSE_POINT` protects the final component, but a parent directory can still be replaced between validation and open. This is a path-based time-of-check/time-of-use gap. The reader must not consume bytes until the opened handle itself has been proven to resolve beneath the canonical server root.

The existing console log reader already applies the needed post-open check: it obtains the resolved path from the open handle on Windows and Linux, then checks containment. Reuse or mirror that behavior for startup diagnostics. Fail closed on any other target until a handle-path check has been verified there. This is a read-only diagnostics path; a rejected or unavailable file must not change readiness state or server files.

The crash-report scan is intentionally bounded to 128 directory entries. When it reaches that cap, the resulting diagnostic must say that the scan was incomplete, because a newer report may have been outside the scanned sample.

## Review Follow-up: Entry Disappears After Enumeration

The next independent review confirmed handle containment and the cap warning, but found a remaining evidence race: after a crash report is returned by `read_dir`, it can disappear before either metadata inspection or the later read. Treating that `NotFound` as an ordinary absent file falsely implies a complete scan. Mark the evidence incomplete when a previously enumerated report disappears at either open. Rust documents that filesystem operations are subject to TOCTOU races and that `read_dir` yields fallible entries; applying that guidance to this enumerated-then-opened report is an inference from the current sequence.

## Sources

- Microsoft documents `FILE_FLAG_OPEN_REPARSE_POINT` as changing handling of the final reparse point and documents querying an open handle's resolved path with [`GetFinalPathNameByHandleW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew). The parent-path race is an inference from the current separate path validation and open sequence.
- Linux exposes open file descriptors through [`/proc/<pid>/fd`](https://www.kernel.org/doc/html/latest/filesystems/proc.html#proc-pid-fd); the project already uses the descriptor path for post-open containment in the console reader.
- Rust documents [filesystem TOCTOU races](https://doc.rust-lang.org/std/fs/#time-of-check-to-time-of-use-toctou) and that [`read_dir`](https://doc.rust-lang.org/std/fs/fn.read_dir.html) yields fallible entries whose retrieval can fail during iteration.
