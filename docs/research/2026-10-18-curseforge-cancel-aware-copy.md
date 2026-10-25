# Research — cancellable wrapped CurseForge ZIP preparation

## Finding

The install pipeline already has a bounded nested-archive copier that checks cancellation between 128 KiB chunks and owns the temporary output through an RAII guard. However, CurseForge provider re-resolution calls the non-cancellable archive classifier first. That classifier unwraps a single-file wrapper using a non-cancellable path, so an install can spend time copying a large inner ZIP before it reaches the later cancellable extraction path.

The repair should route this re-resolution through the existing chunked copier and carry the cancellation result back as the install's cancelled state. Dropping the temporary archive guard closes the handle and attempts to remove the partial inner ZIP on cancellation. No archive format or support policy needs to change.

## References

- Rust [`std::io::copy`](https://doc.rust-lang.org/std/io/fn.copy.html) copies until EOF and does not accept a cancellation callback.
- Rust [`Read::read`](https://doc.rust-lang.org/std/io/trait.Read.html) supports caller-controlled repeated reads into a bounded buffer, allowing a cancellation check between chunks.
- Rust [`std::fs::remove_file`](https://doc.rust-lang.org/std/fs/fn.remove_file.html) documents file removal; the current `TemporaryArchive` drop guard closes the handle before removing its temporary file.

## Project evidence

- `resolve_author_server_zip_from_snapshot` reclassifies the pinned archive during install and currently calls the non-cancellable classifier.
- `curseforge_import.rs` already contains `prepare_server_pack_archive_with_cancel` and `copy_nested_archive_with_cancel`; the gap is reaching those helpers from that re-resolution classifier path.
- The temporary archive's `Drop` implementation removes the scratch ZIP on both cancellation and I/O failure.
