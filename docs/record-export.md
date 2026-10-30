# Local staff record export

Run on the machine holding the SQLite database, with Node 24 or newer:

```sh
npm run export -- --format csv --output /private/staff/confirmed-records.csv
npm run export -- --format json --output /private/staff/confirmed-records.json
npm run export -- --help
```

Both `--format csv|json` and `--output <new-file-path>` are required. Options may appear in either order, once each. Unknown options, stdout (`--output -`), and missing arguments are rejected. Relative output paths resolve against the working directory; the parent directory must already exist. Successful export exits 0 and the CLI prints no record data. Errors exit 1 with a generic diagnostic that omits database contents and paths. npm itself may print its ordinary script banner; invoke `node src/export.ts` directly to avoid that banner.

The CLI uses `DATABASE_PATH` from the environment, then the working directory's `.env`, then `data/onboarding.sqlite` in the working directory. Existing environment values take precedence over `.env`, matching server configuration. It opens an existing database read-only and never creates or migrates it. A missing database, incompatible schema, malformed saved values, or unavailable output fails the export.

Access is protected by the operating system: only staff with filesystem access to the source database should run this command. There is no public HTTP export route, network request, or separate application login. Use a private staff directory outside the web public directory and any shared or automatically synced folder. Output files are created exclusively with mode `0600` (owner read/write only); existing paths, including symlinks, are refused. Directory access controls and staff handling of copied files remain the operator's responsibility. A filesystem write failure can leave an incomplete private file; remove it before retrying with that path.

Exports contain every confirmed **saved revision** in `records`, ordered by saved time then record ID. A revised intake may have multiple saved records; this is a history export, not one row per person or an assertion of current approval. Draft changes after saving do not alter prior saved revisions and are excluded. Each exported record includes `id`, `savedAt`, `confirmationHash`, and saved values. The hash is the stored confirmation evidence; export does not independently reconstruct confirmation or validate old records against today's organization schema. Session/channel identifiers, link codes, messages, and draft data are excluded.

JSON is an array of objects with those four fields, retaining original JSON types and nested values. Prefer JSON for lossless exchange. CSV begins with `id,savedAt,confirmationHash`, followed by the sorted union of value leaf columns across saved revisions. Value columns use JSON Pointer escaping, prefixed with `values` (for example `values/contact/email`; `/` and `~` in property names become `~1` and `~0`). Arrays and empty objects are JSON in one cell. Missing columns are empty cells; null is `null`; booleans and numbers are JSON text. Every CSV cell is double quoted with embedded quotes doubled, and records use CRLF; embedded newlines are preserved.

To prevent spreadsheet formula evaluation, CSV cells beginning with `=`, `+`, `-`, or `@` (also after leading whitespace/control characters), or beginning with tab/newline/carriage return, receive a leading apostrophe. This includes potentially unsafe custom column names. That protective prefix intentionally changes CSV text; JSON retains exact saved values. Treat spreadsheets as a viewing format rather than a round-trip storage format.
