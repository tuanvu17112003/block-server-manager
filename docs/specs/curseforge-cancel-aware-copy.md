# Specification — cancellation during wrapped CurseForge ZIP preparation

## Goal

Allow a user cancellation to interrupt the install-time revalidation copy of an author-provided wrapped CurseForge server ZIP, including large inner ZIP files.

## Behavior

- Install-time provider re-resolution uses the existing bounded chunked copy helper when classifying a single-file wrapper.
- The cancellation flag is checked during the copy and after archive preparation. Cancellation returns the pipeline's cancelled result rather than a malformed/unsupported archive error.
- Partial inner ZIP files are closed and the cleanup guard attempts removal when cancellation or I/O failure unwinds the preparation path.
- Normal classification, supported archive layouts, size limits, source pin checks, and publication rules remain unchanged.

## Acceptance criteria

- The install-time re-resolution path does not perform an uninterruptible copy of a nested archive.
- A cancellation observed during copying propagates as `ProviderResolutionError::Cancelled` and then `PipelineTransactionError::Cancelled`.
- Cancellation removes the `.curseforge-inner-*` temporary file under normal filesystem conditions and does not publish the server payload.
- Existing non-pipeline inspection/classification callers retain their current behavior.
