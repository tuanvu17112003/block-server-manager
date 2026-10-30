# Contributing

Thanks for considering a contribution. This document is short on ceremony and long on the one thing that matters
here: **claims must be backed by evidence.**

## Before anything else: the project's core rule

This codebase was built around a single principle — *do not claim more than you can prove*. It shows up everywhere:

- Every modpack format carries an **evidence grade** (`E1`–`E4`). Only a format that has installed and booted a
  real pack end-to-end may be described as "supported". See
  [`docs/audit/19-stop-and-analyse-evidence-standard.md`](docs/audit/19-stop-and-analyse-evidence-standard.md).
- A passing test suite is **not** proof that a feature works. Several of the worst defects in this project's history
  compiled cleanly and passed every test — including a self-asserting no-op test that hid an untested policy for a
  whole release cycle. Read [`docs/audit/24-deviations-register.md`](docs/audit/24-deviations-register.md) if you want
  to see what that looked like in practice.
- If you cannot verify something, say so. "Unverified" is an acceptable answer; an invented grade is not.

So: when you open a pull request, state what you actually measured, not what you believe.

## Getting set up

```powershell
npm install
npm run dev      # Vite + Electron with hot reload
```

Requirements: Windows 10/11 x64, Node.js 20+. No system Java is required — a matching Temurin runtime is downloaded
per server when missing.

## The gate you must pass

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # agent shells only
npm run verify
```

That runs 15 steps: build, unit tests, spec conformance, adapter audits, real-artefact E2 checks, an encoding guard,
contract, services, lifecycle, management, IPC, and a real-UI E2E walk. A pull request that leaves the gate red will
not be merged.

Two of those steps are unusual and worth understanding before you trip over them:

- **conformance** (`scripts/conformance-spec.mjs`) parses the design document and fails when the code disagrees with
  it, citing `file:line`. If you change behaviour that the design document describes, update both.
- **encoding** (`scripts/check-encoding.mjs`) fails on double-encoded UTF-8 in source files. Mojibake inside a string
  literal compiles and passes every test, so only an explicit check catches it. **Never edit source files with
  PowerShell `Set-Content` or `Out-File`** — use the editor or a Node script with an explicit `utf8` encoding. This
  is not hypothetical: it corrupted 65 lines across 16 files, including user-facing error messages.

### Editing source files: use a file editor, never a shell one-liner

This is a working rule, not a preference, and it applies to humans and agents alike.

**Use the editor/`edit`/`write` tool for every change to a source file.** Do not modify source through
`pwsh -Command "node -e \"...\""`, `Set-Content`, `-replace`, heredocs, or any other shell string that has to survive
PowerShell quoting before Node or TypeScript ever sees it.

The failure mode is specific and expensive. PowerShell processes the command before Node runs, so a nested quote,
an apostrophe, a `\n`, a backslash, or a `$` inside the payload is translated, stripped, or terminated early. What
reaches the file is then either a syntax error or — far worse — *silently different code* that still compiles.
Real examples from this repository's history:

- a JSX edit whose shell quoting collapsed, dropping the element entirely. The build passed, because an unused
  handler still compiles. The result shipped with a working restore function and **no button to reach it**, and it
  took a user report to find.
- an `import` insertion mangled into a stray `\nimport` token, producing `TS2304: Cannot find name 'spawnSync'`.
- repeated `Expected ',', got '<eof>'` parse failures from an apostrophe inside a nested single-quoted string.

Each of those cost several repair round-trips for a one-line change. The rule:

| Task | Correct tool |
|---|---|
| Any edit to a tracked source file | `edit` (preferred) or `write` |
| Multi-file mechanical change | a committed `.mjs` script using `fs.writeFileSync(path, text, 'utf8')` |
| Reading a file | `read` / `grep` / `glob`, not `Get-Content` |
| Running a build, test, or gate | the shell is the correct tool |

If a shell command is genuinely unavoidable for a mechanical edit, write it to a `.mjs` file first and run that — the
quoting problem disappears because the code is no longer inside a shell string. Delete such scratch scripts rather
than committing them.

Network-dependent suites (`npm run verify:full`) install real modpacks and need internet plus Java. They are worth
running before a release but are not required for every pull request.

## Code expectations

- **TypeScript everywhere.** No `any` without a comment explaining why it is unavoidable.
- **No new runtime download sources** without an allowlist entry and checksum verification. This application executes
  what it downloads.
- **Adapters recognise and normalise; they do not reimplement.** If a launcher already has a proven installer, the
  adapter's job is to hand the work over — see invariant I2 in
  [`docs/audit/23-synthesis-correct-design.md`](docs/audit/23-synthesis-correct-design.md).
- **Errors must name the format and the reason.** A generic "unrecognized modpack" is a defect: users cannot act on it.

## Tests

- Unit tests live in `electron/test/unit/` and run through `node scripts/unit.mjs`.
- A test that asserts nothing is worse than no test. Before adding one, ask what it would catch if the code were
  broken, and confirm it fails when you deliberately break the code.
- Prefer testing the decision rule over the UI wiring. Several rules in this project are pinned by re-deriving the
  same logic in a test so that a future edit which reintroduces a regression fails loudly — see
  `electron/test/unit/app-first-run-lock.test.ts` for the pattern.

## Commits and pull requests

- Keep a commit to one concern. A commit message should explain **why**, since the diff already shows **what**.
- Reference the relevant deviation-register entry (`DV-nn`) when you fix something that was recorded as broken.
- If you deliberately deviate from the plan, record the deviation rather than improvising silently. That register
  exists precisely so the next person does not have to rediscover your reasoning.
- For UI changes, include a screenshot in the pull request.

## Reporting bugs

Open an issue using the bug report template. The most useful bug reports include the modpack name and source, what
you expected, what happened, and the relevant log tail. If the problem involves a specific pack format, say which one
— format-specific defects are the majority of this project's real bugs.

## Code of conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md). In short: be decent, assume good faith, and
criticise code rather than people.

## Licence

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
