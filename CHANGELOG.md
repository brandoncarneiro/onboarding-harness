# Changelog

User-visible changes will be recorded here. The project is in pre-release development. No versioned public release is declared.

## Unreleased

### Added

- Self-hosted intake for one church or Christian organization, with a fictional example schema and knowledge pages.
- Web chat and Telegram webhook channels, plus optional local or remote `imsg` integration.
- Explicit confirmation of saved values, one-time channel linking, and durable message replay checkpoints.
- Schema customization and grounded replies from locally supplied knowledge pages.
- Staff CSV and JSON export of confirmed saved revisions through a local command.
- Contribution, conduct, and security documentation, issue and pull request templates, and deployment and third-party license guidance.

### Deployment notes

- Node 24 or newer is required.
- Model and messaging credentials are optional for the local example and are supplied by each operator.
- The remote iMessage pair connection is plaintext and must remain on a trusted private connection.
