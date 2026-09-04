# Security Policy

## Supported Versions

`better-trigger` is pre-1.0. Security fixes are only prepared for the latest
published release line of the published packages (`better-trigger`,
`@better-trigger/core`, `@better-trigger/db`, `@better-trigger/kernel` and
`@better-trigger/worker`); older lines do not receive backports.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

Report security issues **privately**, not as a public issue. Use GitHub
Security Advisories for this repository:

<https://github.com/zhy0216/better-trigger/security/advisories/new>

Creating a draft advisory opens a private channel between you and the
maintainers. Please include:

- The affected package(s) and version(s), and how you resolve them
  (workspace, published npm tarball, Docker image, ...).
- A minimal reproduction or proof of concept, or the exact code path
  (route, scheduler/orchestrator input, dependency) that is vulnerable.
- The impact you observed and any workaround you would suggest.

What to expect: maintainers aim to respond to a draft advisory within a few
business days to confirm or triage the report. Because the project is
maintained by a small team on a best-effort basis, we do not promise a fixed
deadline for shipping a patch or release, and we will not guarantee a
remediation timeline in advance.

While a report is being triaged, please do **not** open a public issue,
discussion, or pull request describing the vulnerability until a fix is
released or the advisory is coordinated for disclosure. Dependabot security
updates (see `.github/dependabot.yml`) handle known vulnerable dependencies
through the same private advisory flow.
