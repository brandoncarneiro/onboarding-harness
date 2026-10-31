# Deploy one organization on a Linux server

This is a reference path for a small, single-server installation: Node 24, systemd, Caddy for HTTPS, and SQLite on persistent local disk. Web intake works without a paid model service or a Mac. An existing VM can host it; choose capacity and backup storage for your traffic rather than assuming a free tier or guaranteed price. This is one organization per installation, with one application process and one database. There is no multi-tenant administration, staff web login, or public export API.

Read [architecture](architecture.md) and [operations](operations.md) before collecting real data. These templates have not been deployed to a real Linux host as part of this change; complete the acceptance steps below on your host. No cloud account, domain, or messaging service is provisioned by the repository.

## Host and network prerequisites

Use a maintained Linux distribution with systemd, a persistent disk, an operator account with sudo, and a real DNS hostname pointing to the server. Install Node **24** and npm from a trusted distribution; confirm `node --version` is `v24.x` and record the patch version with the deployed commit. The service template assumes `/usr/local/bin/node`; replace that path if `command -v node` reports another system-wide installation. A user shell's nvm installation is unsuitable for the service's `ProtectHome=true` layout. Install Caddy using its [official distribution instructions](https://caddyserver.com/docs/install), with its [official systemd service](https://caddyserver.com/docs/running#linux-service).

Before starting the app, set the provider firewall and host firewall to allow public TCP 80/443 and restrict SSH to authorized operator sources. Apply equivalent rules to **IPv4 and IPv6**. Deny external access to TCP **8787** and **8791** (or their configured replacements). The current Node HTTP and pair listeners bind all interfaces; Caddy does not make those listeners private. Keep the pair port blocked even when using an SSH tunnel. No Caddy route should proxy it. Verify these restrictions from a different host, including IPv6 when configured.

Caddy's [automatic HTTPS](https://caddyserver.com/docs/automatic-https) needs valid DNS and access for certificate issuance. Retain its certificate state under the installation's normal Caddy data directory. Do not put application data or exports in Caddy's web root.

## Files and identity

The following initial setup is for a **new host**. Use an operator-owned staging checkout to acquire and review an exact source commit from the intended repository; never upload your working directory or its ignored databases, environment files, and audit artifacts.

```sh
git clone https://github.com/brandoncarneiro/onboarding-harness.git onboarding-harness-source
cd onboarding-harness-source
# Select the reviewed full commit hash. Access may require GitHub authentication.
git checkout --detach REVIEWED_FULL_COMMIT_HASH
npm ci
# Development acceptance includes real secret-scanner regression tests.
node scripts/install-gitleaks.mjs "$HOME/.local/share/onboarding-harness/gitleaks-8.30.1/bin"
export PATH="$HOME/.local/share/onboarding-harness/gitleaks-8.30.1/bin:$PATH"
npm test
npm run typecheck
```

Run the installation commands below from that checkout after those checks pass. `git archive HEAD` packages committed source only, so locally applied, uncommitted fixes are not part of a deployment. Replace the commit placeholder above before executing it.

```sh
sudo useradd --system --user-group --home-dir /var/lib/onboarding-harness --shell /usr/sbin/nologin onboarding-harness
sudo install -d -m 0755 /opt/onboarding-harness/releases
sudo install -d -m 0750 -o root -g onboarding-harness /etc/onboarding-harness
sudo install -d -m 0700 -o onboarding-harness -g onboarding-harness /var/lib/onboarding-harness
release_id=$(git rev-parse HEAD)
sudo install -d -m 0755 "/opt/onboarding-harness/releases/$release_id"
git archive HEAD | sudo tar -x -C "/opt/onboarding-harness/releases/$release_id"
sudo ln -s "/opt/onboarding-harness/releases/$release_id" /opt/onboarding-harness/current
sudo install -m 0600 .env.example /etc/onboarding-harness/environment
sudo install -m 0644 deploy/onboarding-harness.service /etc/systemd/system/onboarding-harness.service
```

Application runtime uses Node's built-ins and needs no production npm packages or compiled output. The checks above use the lockfile's development packages in the staging checkout. The release directory is root-owned and not writable by the service. Do not rerun initial setup against an existing installation; use the upgrade process in [operations](operations.md).

Edit `/etc/onboarding-harness/environment` privately as root; keep it mode `0600`. systemd reads the file before dropping to the service identity. Use plain `KEY=value` entries, not shell commands or `export`. At minimum set:

```dotenv
PORT=8787
DATABASE_PATH=/var/lib/onboarding-harness/onboarding.sqlite
ORGANIZATION_SCHEMA_PATH=/etc/onboarding-harness/record.schema.json
KNOWLEDGE_DIR=/etc/onboarding-harness/knowledge
MODEL_API_KEY=
MODEL_BASE_URL=
MODEL_NAME=
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
IMSG_MODE=
```

Install your reviewed schema as `/etc/onboarding-harness/record.schema.json`, owned by `root:onboarding-harness`, mode `0640`; install the knowledge directory with mode `0750` and its Markdown files mode `0640` under the same ownership. For a fictional smoke test, copy the corresponding files from `fixtures/` with those permissions. Follow [schema customization](schema.md) to replace the fictional organization before launch. Keep configuration outside the release directory so upgrades preserve it. Keep optional credentials blank until you deliberately enable that integration. Do not add a `.env` to the release checkout; configuration comes from the service environment file.

## Start and verify

Replace `intake.example.org` in [deploy/Caddyfile](../deploy/Caddyfile) with your actual DNS hostname and install its contents as `/etc/caddy/Caddyfile`. On a host already running Caddy, merge this site block with the existing configuration. Verify the absolute Node path in the systemd unit before starting.

```sh
sudo systemd-analyze verify /etc/systemd/system/onboarding-harness.service
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now onboarding-harness
sudo systemctl reload caddy
systemctl is-active onboarding-harness caddy
curl --fail https://YOUR_REAL_HOSTNAME/health
```

If Caddy was not started by its installation, use `sudo systemctl enable --now caddy` before its reload. `/health` reports only that the HTTP process answers; it does not prove database writes, model availability, or message delivery. Open the HTTPS page, complete a fictional intake including agreement and final `Yes`, then verify its saved revision with the local export command. Restart the app with `sudo systemctl restart onboarding-harness`, reopen the same test session, and verify that state persists. Verify port blocking externally and check that files under `/var/lib/onboarding-harness` are private. Test one backup and restore to a new path before collecting real records.

systemd restarts unexpected process exits and starts the app on reboot; repeated early failures hit the unit's start limit. Fix the cause in private logs, then use `sudo systemctl reset-failed onboarding-harness` and start it again. A healthy process can still have a failed optional channel. Monitor HTTPS reachability, free disk space, backup age and restore results separately.

## Optional remote Mac companion

The cloud server owns the intake state; a Mac running Messages owns Apple account access and the `imsg` process. Telegram and web intake do not require that Mac. The companion is an optional text channel, not a claim that this harness supports every upstream imsg feature.

The reference version is **imsg v0.20.0**, the latest non-prerelease verified on 2026-10-30 ([release](https://github.com/openclaw/imsg/releases/tag/v0.20.0)). Obtain that version's signed `imsg-macos.zip` and `SHA256SUMS` from that release, compare the archive hash with the published checksum, and unpack into a new private version-specific directory. Set `IMSG_COMMAND` to the absolute path of the unpacked executable and confirm `imsg --version` reports `0.20.0`. A general Homebrew installation can select a newer release; it is not a version pin. Review and repeat acceptance before changing the pinned version. Verification of a published version is not proof of compatibility on a real device.

Upstream's [versioned installation](https://github.com/openclaw/imsg/blob/v0.20.0/docs/install.md) and [permissions guide](https://github.com/openclaw/imsg/blob/v0.20.0/docs/permissions.md) cover macOS 14+, Messages sign-in, Full Disk Access for the actual parent process reading the Messages database, and Automation permission to control Messages for sends. Contacts access is optional. SMS additionally needs iPhone Text Message Forwarding. Keep SIP enabled; this harness uses the ordinary read/watch/send RPC surface, not upstream's advanced injected features.

On the cloud server set `IMSG_MODE=remote` and `IMSG_PAIR_PORT=8791`, then restart the harness. Its journal contains a short-lived one-time pairing code: read it privately and do not paste it into issue reports. A lost or consumed code needs a fresh server-issued code; the current runtime issues one at startup, so arranging a new code involves restarting the service and a brief web outage.

On the Mac, create an **outbound encrypted SSH tunnel** to an authorized SSH account on the cloud server. Verify the host key through a trusted source first, and use an account/key restricted to the required forwarding destination where your SSH policy permits. Replace the example destination below:

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:18791:127.0.0.1:8791 operator@YOUR_REAL_HOSTNAME
```

The local forward binds the Mac's loopback only. Cloud TCP 8791 remains blocked by both firewalls; SSH reaches the cloud listener over cloud loopback. This requires no inbound Mac port. The application pairing protocol itself is **plaintext**; the tunnel provides transport encryption. Never connect it directly across the public internet.

In a separate private Mac checkout with Node 24, create a mode `0600` `.env` with `IMSG_PAIR_HOST=127.0.0.1`, `IMSG_PAIR_PORT=18791`, the fresh `IMSG_PAIR_CODE`, and the absolute `IMSG_COMMAND`. Then run:

```sh
node src/imsg-companion.ts
```

Keep the tunnel and companion running in the logged-in Mac user context that has the required permissions. Mac launch supervision and automatic re-pairing are not supplied: a used code cannot reconnect, and simply looping a launch command does not solve it. After tunnel/companion loss, arrange a fresh code and restart the companion. A supervisor that silently retries a consumed code is not a working recovery plan.

Before enabling this channel for participants, test permission prompts under the actual launch context, one-to-one inbound text and outbound replies, restart/re-pair behavior, and uncertain send acknowledgments with an explicitly consenting test recipient. A reply may duplicate when Messages accepted it but the acknowledgment was lost; intake mutation is replay-protected. Real iMessage/SMS delivery, macOS permissions and encrypted tunnel operation remain **unverified** by this documentation change.
