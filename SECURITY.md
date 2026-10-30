# Security Policy

## Supported versions

This project ships as a desktop application built from `master`. Only the latest published release receives
security fixes; older versions are not maintained in parallel.

| Version | Supported |
|---|---|
| Latest release on `master` | Yes |
| Anything older | No — please update |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** A public report tells everyone about the flaw before
a fix exists.

Use GitHub's private vulnerability reporting instead:

1. Go to the [Security tab](https://github.com/tuanvu17112003/block-server-manager/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe what you found, how to reproduce it, and what an attacker could do with it.

If private reporting is unavailable to you, open a public issue containing **only** a request for a private
channel — no technical detail — and a maintainer will follow up.

### What to include

- The affected version or commit.
- Steps to reproduce, ideally minimal.
- The impact you believe it has.
- Any suggested fix, if you have one.

### What to expect

This is a volunteer-maintained project, so these are intentions rather than a contractual SLA:

- Acknowledgement of your report: within 7 days.
- An initial assessment: within 14 days.
- Credit in the release notes once a fix ships, unless you ask to stay anonymous.

## Scope

In scope:

- The Electron main process, IPC layer, and renderer.
- Archive/modpack parsing — malformed or hostile archives are a realistic attack surface for this application.
- Remote download handling: URL allowlists, redirect handling, and checksum verification.
- Anything that could let a downloaded modpack execute code outside the managed server sandbox.

Out of scope:

- Vulnerabilities in Minecraft itself, in mods, or in the modpack authors' content.
- Issues that require an attacker to already have local administrator access.
- Reports produced solely by an automated scanner without a demonstrated impact.

## A note on the application's own security posture

This project deliberately keeps secrets out of the repository and out of support bundles:

- The CurseForge API key is encrypted with Electron `safeStorage` and is never bundled, logged, or included in a
  diagnostics bundle.
- Downloads are restricted to an allowlist of trusted hosts, and archives are re-hashed before use.
- Local application data (`.app-data/`) is git-ignored and must never be committed.
