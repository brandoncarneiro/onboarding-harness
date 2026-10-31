# Security policy

## Supported development

This project is in pre-release development. Reports should identify the exact commit and Node version affected. Maintainers evaluate reports against the current `main` branch. No released-version support schedule or guaranteed response time is established.

## Report privately

**[PRIVATE_SECURITY_CONTACT — replace with a monitored private security reporting address or a verified private vulnerability-reporting URL before publication]**

This placeholder is not a reporting destination. This policy is not ready to publish until the private channel is configured, tested, and staffed.

Do not open a public issue or pull request with exploit details, credentials, real intake records, chat transcripts, or participant identifiers. If a report includes sensitive data, minimize and redact it. Use a fictional record or local fake whenever possible.

Include:

- The affected commit, Node version, operating system, and enabled channels.
- The affected component and security impact.
- Minimal reproduction steps and expected versus observed behavior.
- A safe proof of concept and any mitigation you have verified.
- A private way to contact you for follow-up.

Test only systems and accounts you own or have permission to assess. Do not send unsolicited messages, access another organization's records, or disrupt a running installation.

## Handling and disclosure

Maintainers will assess the report, coordinate follow-up privately, and work with the reporter on an appropriate disclosure plan. Do not assume a patch or disclosure date until agreed.

## Deployment boundaries

The harness stores personal intake data and replay checkpoints in SQLite. Operators are responsible for access control, backups, retention, and safe handling of exports. The iMessage pair socket is plaintext and must not be exposed publicly. See the [deployment guidance](docs/deployment.md) and [record export documentation](docs/record-export.md) before deploying with real data.
