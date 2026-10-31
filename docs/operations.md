# Operate the installation

Use the layout and service in [deployment](deployment.md). Keep a named operator responsible for private credentials, access reviews, backups, restores and participant data requests. Use fictional data for exercises. The host's filesystem and administrators are the access boundary; the app does not encrypt SQLite at rest or provide a staff login. Use encrypted disks and encrypted off-host backups appropriate to your organization.

## Backup and restore

SQLite uses WAL mode. Copying only a live `.sqlite` file can omit committed data in its `-wal` sidecar. Use SQLite's [backup API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html#sqlitebackupsource-db-path-options), as wrapped by [deploy/sqlite-snapshot.mjs](../deploy/sqlite-snapshot.mjs). It opens an **existing** source read-only, creates a new private directory, makes a consistent snapshot and checks SQLite integrity and foreign keys. It never overwrites an existing database. The output path is printed only after checks pass; a failure can leave an incomplete private artifact which must not be used.

Create the backup parent once, on persistent disk, and run snapshots as the service identity. The destination parent must already exist and be private. Choose a different private parent outside the service's writable disk for off-host storage using your existing backup tooling; encrypt transfers and stored copies.

```sh
sudo install -d -m 0700 -o onboarding-harness -g onboarding-harness /var/lib/onboarding-harness/backups
sudo -u onboarding-harness /usr/local/bin/node /opt/onboarding-harness/current/deploy/sqlite-snapshot.mjs /var/lib/onboarding-harness/onboarding.sqlite /var/lib/onboarding-harness/backups
```

The command makes a fresh `snapshot-XXXXXX/onboarding.sqlite`, mode `0600` in a mode `0700` directory. It can run with the service up; do not run competing schema upgrades during the snapshot. Back up before each upgrade and on a documented regular schedule based on how much intake the organization can afford to lose (for example daily, with an operator alert when the latest successful copy is older than that interval). This repository does not install a scheduler or off-host backup service. Monitor failures and disk space; a backup on the same VM does not survive losing that VM.

Store a matching deployment manifest with the exact application commit, Node patch version and organization schema/knowledge version. Back up the configuration separately, with credentials encrypted and accessible only to authorized operators. A CSV export is not a database backup: it omits drafts, channel linkage, consent workflow and replay state.

To restore, stop the service and prevent other processes, including staff tools, from opening the database. Keep the current database and all its sidecars intact. **Restore to a new path**, never on top of the existing database:

```sh
sudo systemctl stop onboarding-harness
systemctl is-active onboarding-harness
sudo install -d -m 0700 -o onboarding-harness -g onboarding-harness /var/lib/onboarding-harness/restores
# Replace this source with the exact chosen, verified backup path.
sudo -u onboarding-harness /usr/local/bin/node /opt/onboarding-harness/current/deploy/sqlite-snapshot.mjs /var/lib/onboarding-harness/backups/snapshot-CHOSEN/onboarding.sqlite /var/lib/onboarding-harness/restores
```

`is-active` must report `inactive` (its nonzero exit is expected). The snapshot command prints the **new** restore database path. Set `DATABASE_PATH` in `/etc/onboarding-harness/environment` to that absolute path, select the application and organization configuration matching the backup, then start the service. Verify `/health`, a fictional intake/save, same-session persistence and a staff export. Keep optional outbound channels disabled for an isolated drill: restored checkpoints may retry pending replies, and rolling back to an older backup can lose deduplication of messages accepted since that backup. Plan reconciliation before reconnecting real messaging channels. An offline integrity check cannot prove that reconciliation or provider delivery succeeded.

Practice this process on synthetic data and periodically on an isolated, access-controlled restore host before a real recovery. Record the chosen snapshot, recovery time, accepted data-loss window and acceptance results. Retain the old database until the recovery has been accepted under the organization's retention policy; cleanup is a separate authorized operation.

## Upgrade without losing state

Prepare a **new** root-owned release directory for an exact reviewed commit, using the acquisition, `npm ci`, tests and typecheck steps in deployment. Record the old release target, configuration version and Node version. Read changes to `src/db.ts`, the schema and release notes before touching the active database. Database migrations run automatically on startup; there is no general down-migration command or promise that an old application can open a newer schema.

Stop intake in a maintenance window, stop the service, and take a verified snapshot of the stopped database. Retain both code versions and the matching configuration. Update `/opt/onboarding-harness/current` to the prepared release, with the service stopped, then start it and repeat deployment acceptance. Do not run two app processes against the same database during the switch. Keep the external `DATABASE_PATH`, schema and knowledge paths unchanged unless the reviewed change explicitly requires otherwise.

For rollback, stop the service again. If schema or data compatibility is uncertain, use the new-path restore procedure with the pre-upgrade snapshot and prior release/configuration; do not simply start old code against a migrated database. Reconcile any post-snapshot activity before reconnecting channels. Keep maintenance effects and acceptance evidence separate from a successful process start.

## Retention and participant deletion

There is **no implemented retention job, participant deletion CLI, or universal deletion SQL recipe**. Code expiry is an authorization rule, not data cleanup. Define the retention period, authorized staff, request verification, export/backup expiry and external-provider obligations before collecting real data. If enforceable timed erasure or self-service deletion is required, this version needs an implementation and verification before that use.

For a verified participant request, an authorized operator must take the service offline and inspect an access-controlled working snapshot against the exact deployed schema. Resolve all linked session identities and saved revisions, including any groups/records left by earlier link merges. Account for `session_groups`, `sessions`, `records`, `link_codes`, and **both** replay stores: `incoming_requests` contains original text and serialized draft/result values, while `telegram_updates` contains chat IDs and replies. These stores have no universal cascading participant relationship. A name/email match is not reliable proof of ownership, and removing only a `records` row leaves personal data behind. Incoming checkpoints have no age column, so generic timestamp purges cannot prove completeness either.

Before applying a narrowly reviewed, parameterized transaction to the selected offline database, demonstrate on synthetic linked/retried/edited records that its identity mapping is complete, unrelated participants remain untouched, references remain valid and old delivery checkpoints cannot recreate or resend removed data. Verify foreign keys and inspect residual text/JSON as well as relational rows. If that mapping cannot be proved, do not improvise bulk SQL; implement and review a schema-aware deletion procedure first. Report the request as pending rather than claiming erasure.

Logical row removal also leaves possible copies in SQLite free pages/WAL, snapshots, staff exports, browser storage, logs, Mac Messages, Telegram and optional model-provider systems. Apply the organization's authorized storage sanitization/backup expiry process and provider procedures separately, documenting any required preservation and the actual completion limits. Restoring an old backup can reintroduce removed data; maintain a protected deletion/reconciliation record outside the restored database and apply verified requests before reopening service. This guide intentionally supplies no destructive whole-database or unscoped DELETE shortcut.

## Staff exports and logs

Use the local [record export](record-export.md) command on the database host. Set `DATABASE_PATH` explicitly to the active database when invoking it outside systemd; the service's environment file is not automatically loaded into an operator shell. Create a private staff destination directory outside the application, web root, source tree and shared/synced storage. Each output must be a new path. CSV and JSON outputs are created mode `0600`; transferred copies need equivalent access restrictions and retention handling. CSV exports every saved revision and neutralizes spreadsheet formulas; JSON preserves values for lossless exchange.

Read `journalctl -u onboarding-harness` only in an authorized private session. Remote-mode startup writes a pairing code to the journal; do not publish raw logs or broad journal dumps. Restrict journal access and set a host-appropriate log retention policy alongside database/backups retention. Caddy's supplied site block does not enable access logging; do not add message/body logging during troubleshooting. A health probe returning 200 is separate evidence from a successful intake, a backup restore, Telegram delivery, or an iMessage round trip.
