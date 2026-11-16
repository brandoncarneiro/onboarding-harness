# Agent instructions

## Dependency bots

- Do not add or enable Dependabot, Renovate or any similar dependency-update bot
  (config file, GitHub App or repository setting) without the founder's explicit
  approval.
- When you create a new repository, immediately run
  `gh api -X DELETE repos/<owner>/<repo>/automated-security-fixes` and
  `gh api -X DELETE repos/<owner>/<repo>/vulnerability-alerts`.
