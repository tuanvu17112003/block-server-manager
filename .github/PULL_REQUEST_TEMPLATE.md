## What this changes

<!-- One or two sentences. The diff already shows what you touched; explain the intent. -->

## Why

<!-- The problem this solves. If it fixes a recorded defect, cite the DV-nn entry in docs/audit/24-deviations-register.md. -->

## How it was verified

<!--
This project's rule is that claims must be backed by evidence, so please state what you actually ran rather than
"tests pass". Useful specifics:

- `npm run verify` result (e.g. 15/15 PASS) and unit counts before → after
- Whether you reproduced the problem first, and how
- For a fix: does the new test fail if you revert the fix? A test that cannot fail proves nothing.
- For a UI change: a screenshot or short recording
-->

## Checklist

- [ ] `npm run verify` passes locally
- [ ] Added or updated tests covering the change
- [ ] If behaviour described in the design document changed, updated the document too (the conformance gate parses it)
- [ ] No secrets, API keys, or local paths committed (`.app-data/` stays untracked)
- [ ] Source files were edited with an editor or a UTF-8 writing script — not PowerShell `Set-Content`/`Out-File`, which corrupts encodings
- [ ] For a new download source: added to the allowlist and verified by checksum

## Screenshots

<!-- For any renderer/UI change. Delete this section if not applicable. -->
