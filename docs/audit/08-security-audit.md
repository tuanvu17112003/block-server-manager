# Security audit — secrets and exposed sensitive information

Date: 2026-10-28T05:44:27.058Z · Scope: tracked tree at HEAD (432 files) + full git history + on-disk sensitive files.
All evidence is masked; full secret values are never written to this report.

## Result
**PASS — no live API keys, tokens, passwords or private keys found in the tracked tree or git history.**

| Check | Result |
|---|---|
| Tracked files scanned | 432 (binary/oversized skipped) |
| Live-secret pattern hits (non-placeholder) | 0 |
| Test/fixture placeholder hits (expected, fake values) | 13 |
| Sensitive filenames ever committed | 0 |
| History diff live-secret hits | 0 |
| History diff placeholder hits (test fixtures/docs) | 13 |
| History pickaxe context commits (excluding code references) | 7 |
| Untracked sensitive files that would be committed | 0 |
| Ignored local secret files (never pushed) | 1 |
| Tracked files > 2 MB | 0 |

## Findings
No actionable findings. The only pattern hits are deliberate fake credentials in unit tests (see below), and the `.gitignore` excludes the local development data root (`.app-data/`) that holds the real CurseForge key and server data.

## Expected test fixtures (not real secrets)
| File | Line | Pattern | Value (masked) | Note |
|---|---|---|---|---|
| `electron/test/unit/diagnostics.test.ts` | 172 | assigned-secret | abcd…90 (16 chars) | Test/fixture placeholder |
| `electron/test/unit/diagnostics.test.ts` | 173 | assigned-secret | SUPE…23 (16 chars) | Test/fixture placeholder |
| `electron/test/unit/diagnostics.test.ts` | 174 | assigned-secret | quot…ue (19 chars) | Test/fixture placeholder |
| `electron/test/unit/diagnostics.test.ts` | 175 | assigned-secret | tops…er (15 chars) | Test/fixture placeholder |
| `electron/test/unit/diagnostics.test.ts` | 176 | assigned-secret | abcd…56 (12 chars) | Test/fixture placeholder |
| `electron/test/unit/diagnostics.test.ts` | 177 | assigned-secret | api-…ue (16 chars) | Test/fixture placeholder |
| `electron/test/unit/diagnostics.test.ts` | 178 | assigned-secret | anot…et (18 chars) | Test/fixture placeholder |
| `electron/test/unit/diagnostics.test.ts` | 197 | authorization-header-literal | Auth…en (41 chars) | Test/fixture placeholder |
| `electron/test/unit/diagnostics.test.ts` | 212 | assigned-secret | raw-…ue (15 chars) | Test/fixture placeholder |
| `electron/test/unit/diagnostics.test.ts` | 242 | assigned-secret | secr…ue (12 chars) | Test/fixture placeholder |
| `electron/test/unit/diagnostics.test.ts` | 389 | authorization-header-literal | Auth…er (39 chars) | Test/fixture placeholder |
| `electron/test/unit/secrets.test.ts` | 61 | curseforge-classic-key | $2a$…UV (65 chars) | Test/fixture placeholder |
| `electron/test/unit/validate-ipc.test.ts` | 179 | curseforge-classic-key | $2a$…UV (65 chars) | Test/fixture placeholder |

## History review
- Sensitive filenames ever added: none
- Full-diff secret-pattern scan: no live secrets found
- History diff placeholder/fixture hits: 13
| Commit | Pattern | Value (masked) | Class |
|---|---|---|---|
| `7a55dad858` | curseforge-classic-key | $2a$…UV (65 chars) | test/docs placeholder |
| `7a55dad858` | curseforge-classic-key | $2a$…UV (65 chars) | test/docs placeholder |
| `f4d4acd7ae` | assigned-secret | abcd…90 (16 chars) | test/docs placeholder |
| `f4d4acd7ae` | assigned-secret | SUPE…23 (16 chars) | test/docs placeholder |
| `f4d4acd7ae` | assigned-secret | quot…ue (19 chars) | test/docs placeholder |
| `f4d4acd7ae` | assigned-secret | tops…er (15 chars) | test/docs placeholder |
| `f4d4acd7ae` | assigned-secret | abcd…56 (12 chars) | test/docs placeholder |
| `f4d4acd7ae` | assigned-secret | api-…ue (16 chars) | test/docs placeholder |
| `f4d4acd7ae` | assigned-secret | anot…et (18 chars) | test/docs placeholder |
| `f4d4acd7ae` | authorization-header-literal | Auth…en (41 chars) | test/docs placeholder |
| `f4d4acd7ae` | assigned-secret | raw-…ue (15 chars) | test/docs placeholder |
| `f4d4acd7ae` | assigned-secret | secr…ue (12 chars) | test/docs placeholder |
| `f4d4acd7ae` | authorization-header-literal | Auth…er (39 chars) | test/docs placeholder |
- Pickaxe context commits: `cfc_pat_` in 24d0da5 chore(security): add reproducible security audit (tracked tree + full git history) and untrack internal .workflo; `$2a$10` in 24d0da5 chore(security): add reproducible security audit (tracked tree + full git history) and untrack internal .workflo; `$2a$10` in 7a55dad fix(curseforge-key): accept real classic key formats (\$ / + = etc.) — printable ASCII instead of URL-safe-only ; `gzp_` in 24d0da5 chore(security): add reproducible security audit (tracked tree + full git history) and untrack internal .workflo; `ghp_` in 24d0da5 chore(security): add reproducible security audit (tracked tree + full git history) and untrack internal .workflo; `BEGIN RSA PRIVATE KEY` in 24d0da5 chore(security): add reproducible security audit (tracked tree + full git history) and untrack internal .workflo; `BEGIN OPENSSH PRIVATE KEY` in 24d0da5 chore(security): add reproducible security audit (tracked tree + full git history) and untrack internal .workflo; `x-api-key` in 24d0da5 chore(security): add reproducible security audit (tracked tree + full git history) and untrack internal .workflo; `x-api-key` in f4d4acd feat(phase7): architecture/security/docs — shared contracts + IPC arg validation (71 commands), Electron-only ad; `x-api-key` in da3ab4a feat(electron): P2 module integration — modrinth/curseforge engines + curated L4 data, pipeline preview/install ; `x-api-key` in a391ff1 feat(electron): P0 shell — electron main/preload/ipc, JSON server store, adapter branch, selftest gate (src-taur
- `x-api-key` / `Authorization` matches in code are header names, not values (no credential found).

## Local (never pushed) sensitive files
- `.app-data/curseforge-key.enc` (91 bytes) — git-ignored; must never be committed.

## Hardening notes
- `.gitignore` excludes `.app-data/` (incl. `curseforge-key.txt`), build outputs, logs and verification artifacts.
- The CurseForge key is stored at runtime (safeStorage or app-data fallback), never compiled in; support bundles redact it and the diagnostics logger redacts token-shaped values.
- Tests use random/obviously fake key strings only.
- GitHub Advanced Security secret scanning is not available for this private repository (GHAS not enabled); this local audit is the equivalent check and also scans every commit diff, not just the default branch.
- Before publishing, confirm the repository is **private** unless the user explicitly wants it public.

