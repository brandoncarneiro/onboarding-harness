# Contributing

Thanks for helping improve the onboarding harness. It is a self-hosted intake service for one church or Christian organization per installation. Keep changes focused on that purpose and the documented V0 behavior.

## Before you begin

Read [README.md](README.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md). Report security concerns privately using the security policy; do not include sensitive details in public issues or pull requests. For a change that affects public behavior or architecture, open an issue describing the problem and proposed result first. Small bug fixes and documentation corrections can go directly to a pull request.

## Local setup

Clone or download this repository and open a shell in its root. Install Node 24 or newer; `.nvmrc` selects Node 24 if you use nvm.

```sh
nvm use # optional: only if nvm is installed
npm ci
cp .env.example .env
npm start
```

Open http://127.0.0.1:8787. No model key or messaging credentials are needed for the local example. Use fictional data. Keep `.env`, databases, exported records, message content, credentials, and local logs out of commits. Review `git diff --cached` before committing.

## Checks

Install Gitleaks **8.30.1** using the checksum-verified [README instructions](README.md#install), then install the repository-local hooks. The scanner is required for the hook regression tests and secret checks; it is not an application runtime dependency. Setup preserves existing hook configuration and refuses conflicts. Do not bypass a failed scanner or remove the hook to commit a credential.

```sh
npm run setup:hooks
npm test
npm run typecheck
npm run check:secrets
```

Tests use local fakes and temporary data; they do not need model keys or network access. Add meaningful regression coverage for behavior changes. Document a public configuration or API change in the relevant README or docs page. State which checks you ran and any limits on verification in your pull request.

## Changes and review

Follow the existing TypeScript style and patterns. Keep a pull request focused; avoid unrelated refactors or formatting changes. Preserve retry, consent, one-to-one chat, and record confirmation behavior unless the proposed change explicitly addresses it. Do not weaken checks to make tests pass.

Create a branch for your change and open a pull request targeting `main`, the primary branch. A pull request should explain the user-visible problem, the resulting behavior, and the evidence that it works. Use sanitized reproduction steps. Maintainers review contributions before merging; review timing is not guaranteed. Do not commit credentials or private records.

Branch protection and required checks are not currently enforced by GitHub. If the repository becomes eligible for the intended GitHub protections, maintainers should require pull requests, independent approval, and passing checks on `main` before merging. Until then, follow this review process explicitly; documentation alone does not enforce it. Automated check results apply to the tested commit and do not establish real Telegram, Mac Messages, or deployment acceptance.

## Licensing and attribution

Submit only material you have the right to contribute. Contributions to project code are made under the [MIT license](LICENSE). Preserve third-party copyright and license notices, identify any copied or adapted material and its source, and explain any licensing requirements. Contributor Covenant in `CODE_OF_CONDUCT.md` has its own CC BY-SA 4.0 attribution and license.
