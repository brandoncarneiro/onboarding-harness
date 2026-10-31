# Onboarding harness

A free, self-hosted intake harness for one church or Christian organization. One install serves one organization. The organization supplies its own record schema and its own pages.

V0 is one conversation that saves a record. A person can finish it in Telegram, in the plain web chat, or by phone and iMessage. Telegram is the channel that runs without a Mac. Phone and iMessage need the Mac that is signed into Messages.

The checked-in example is a fictional local church, Example Community Church. No customer is represented here.

## Install

Clone this repository and open a shell in its root. Node 24 or newer is required. If you use nvm, `nvm use` selects the checked-in Node version; otherwise skip that command. Use fictional data while evaluating the example.

```bash
git clone https://github.com/brandoncarneiro/onboarding-harness.git
cd onboarding-harness
nvm use # optional: only if nvm is installed
npm ci
cp .env.example .env
npm start
```

The server listens on port 8787 unless `PORT` is set. Open `http://127.0.0.1:8787`.

`.env.example` lists setting names only. Put values in `.env`, which is not committed. Tests do not read a model key and do not use the network.

Development checks also require Gitleaks **8.30.1**. If it is not already on your PATH, install the checksum-verified binary into a version-specific directory:

```sh
node scripts/install-gitleaks.mjs "$HOME/.local/share/onboarding-harness/gitleaks-8.30.1/bin"
export PATH="$HOME/.local/share/onboarding-harness/gitleaks-8.30.1/bin:$PATH"
```

Install this checkout's secret-prevention hooks before contributing. Setup refuses to replace conflicting existing hooks; integrate those explicitly. Commits scan the actual staged files and pushes scan full history, with redacted findings. These local safeguards do not establish GitHub branch protection or required-check enforcement.

```bash
npm run setup:hooks
npm test
npm run typecheck
npm run check:secrets
```

Staff can retrieve confirmed submissions on the server with `npm run export -- --format csv --output /private/staff/intake.csv` (use a new file in an existing private directory). JSON is also supported. Export includes saved revisions, excludes drafts, and creates owner-only files. See [record export](docs/record-export.md) for access, format, and handling instructions.

Without `MODEL_API_KEY`, the server uses a local model that repeats a reply the server has already checked. To use your own model, set `MODEL_API_KEY`, `MODEL_BASE_URL`, and `MODEL_NAME` for any API that accepts OpenAI-style chat completions. The model sits behind `LanguageModel` in `src/model.ts`.

Messages are limited to 4,096 UTF-16 code units (JavaScript string length), measured before trimming whitespace. Oversized messages do not change the intake or call the model. The web API returns HTTP 413; messaging channels return a request to shorten the message.

## Example Community Church

The demo schema is `fixtures/record.schema.json`. It asks for name, email, mobile, organization name, and city, plus the agreements that schema marks required. Replace that file to change the intake. Field titles come from the schema.

The root schema title supplies the church name on the web page. Only the documented schema subset is supported; invalid types or unsupported validation rules stop startup. See [schema customization](docs/schema.md). Draft answers are stored as people type them, before final consent; the web page explains this. Final confirmation accepts `yes` or `Yes` after the summary.

The demo pages are the only knowledge in this repo:

- `fixtures/knowledge/contact.md`
- `fixtures/knowledge/visit.md`
- `fixtures/knowledge/videos.md`

Edit those pages, or point `KNOWLEDGE_DIR` at another folder of the same shape. Each page has a URL, a title, and one or more passages. A video page carries a title only.

Start the server and open the web chat. The page asks for the first field. In Telegram, `/start` does the same thing. The first answer is the name. The conversation then asks for the remaining fields.

```text
What is your Name?
Sample Person

What is your Email?
person@example.com

What is your Mobile?
555-0100

What is your Organization name?
Sample Organization

What is your City?
Sample City

I agree these details may be stored for this intake. Reply yes to agree.
yes

Confirm this exact set of details:
Name: Sample Person
Email: person@example.com
Mobile: 555-0100
Organization name: Sample Organization
City: Sample City
I agree these details may be stored for this intake: yes
Reply yes to confirm.

yes

The details are saved.
```

The record is written only after the person confirms that exact set. The confirmation is a hash of those values. `change city to Other City` clears the confirmation. The previous hash does not confirm the edited set. The reply says the details are saved. It does not say the person is registered, approved, or signed up.

Ask `What is the office phone?` The reply can include `The office phone is 555-0100.` because that sentence is a passage on the contact page. A search miss is not a fact. A video title is a title: `What does the video say?` is answered with `Video title: Front door tour` and nothing about the picture. The server can return a scripture reference such as `Reference: Example 1:1`. It does not type verse text, and V0 has no Bible API.

## Link a web chat to Telegram

A typed name, email, or mobile number does not connect the two chats. In one chat, send:

```text
link code
```

The server returns a one-time code. In the other chat, send:

```text
use code ABCD2345
```

Use the code you were given. It expires after 15 minutes and works once. The two chats then share one record.

## Safe message retries

Custom web clients must send `POST /api/chat` with JSON `{ "sessionId": "your-session", "requestId": "unique-message-id", "message": "your answer" }`. Both IDs use 1–80 letters, digits, underscores or hyphens. Generate a new request ID for a new user action. After response loss, resend the same ID and exact original message; the stored result is returned without interpreting that answer again. Reusing an ID with different text returns HTTP 409. The bundled page retains a pending request across reloads and provides a Retry message button.

Intake changes and their replay checkpoint commit together. Confirmation is never inferred from a retry of an earlier consent response. Replay checkpoints contain message text and response/draft data alongside the existing intake database; include them in the organization's data-handling policy.

## Point Telegram at the webhook

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` in `.env`. Restart the server. Telegram must be able to reach an HTTPS URL on this process.

```bash
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://YOUR_HOST/api/telegram/webhook","secret_token":"YOUR_TELEGRAM_WEBHOOK_SECRET"}'
```

`YOUR_TELEGRAM_WEBHOOK_SECRET` is the same value as `TELEGRAM_WEBHOOK_SECRET`. Telegram sends it in `X-Telegram-Bot-Api-Secret-Token`. A request without that exact secret does not write a session, a record, a link code, or a knowledge row. When the token is set, the server also calls Telegram `sendMessage`. The web page posts to `POST /api/chat` and does not need the bot token.

`GET /health` returns `{"ok":true}`. See [deployment and operator acceptance](docs/deployment.md) for HTTPS, private pairing transport, data handling, and integration checks. A local test pass does not establish live Telegram delivery or Mac Messages operation.

One SQLite file, `data/onboarding.sqlite` unless `DATABASE_PATH` is set, holds records, sessions, link codes, and knowledge pages. Search is full text. Each hit has a URL and a passage.

## Phone and iMessage

Phone and iMessage use the optional external [openclaw/imsg](https://github.com/openclaw/imsg) binary (MIT), which is spawned rather than vendored or installed by npm. The harness speaks JSON-RPC 2.0 to an `imsg rpc` child on stdin and stdout. It calls `chats.list`, `messages.history`, `watch.subscribe`, `watch.unsubscribe`, and `send` only. `send` sets `transport` to `applescript`. The harness does not call the IMCore bridge, `imsg launch`, or anything that needs SIP disabled.

OpenClaw is not imported and not required. Install the `imsg` binary on the Mac that is signed into Messages.

Intake accepts verified one-to-one chats only. Group chats and notifications with missing, malformed, or conflicting chat metadata are ignored without changing the intake or sending a reply. Use an `imsg` version whose watch notifications include `is_group`, `chat_identifier`, `chat_guid`, and `participants`; older versions that omit this metadata cannot start an intake. This restriction applies to both local and remote mode.

iMessage intake also requires each message's GUID. Durable checkpoints prevent a replayed GUID from becoming a new answer, and pending replies are retried after restart. Failed sends receive bounded retries; local connections receive bounded reconnect attempts. If all attempts fail, restart after fixing the connection. If a send reaches Messages but its acknowledgment is lost, a retry can produce a duplicate reply; intake is still applied once. Remote connections require a fresh pairing code after disconnection; a used one-time code cannot reconnect.

Sessions and recovered replies use the verified direct participant's address, not a Mac's numeric chat row. Reconnecting another Mac cannot redirect a queued reply to an unrelated conversation with the same row number. Older numeric iMessage sessions and records are retained, but cannot be assigned automatically to a participant without proof of ownership; reconcile or link them explicitly before continuing. Legacy pending replies without a verified recipient are not sent automatically.

On that same Mac, set `IMSG_MODE=local`. The harness spawns `imsg rpc`.

When the harness runs on another machine, set `IMSG_MODE=remote`. It prints a one-time pair code and listens on `IMSG_PAIR_PORT` (8791 unless you set it). On the Mac, set `IMSG_PAIR_HOST`, `IMSG_PAIR_PORT`, and `IMSG_PAIR_CODE`, then run:

```bash
node src/imsg-companion.ts
```

The companion dials out, presents the code, and forwards the local `imsg rpc` stdio. A code that is missing, wrong, used, or expired is rejected and writes nothing. The pair socket is plaintext. Do not expose it on a public port. Telegram keeps working with no Mac.

## Later adapters

`src/adapters.ts` names interfaces for work that is not part of V0. Those projects are not imported and are not dependencies.

| Later work | Project | License |
| --- | --- | --- |
| Site crawl that fills the knowledge loader | [unclecode/crawl4ai](https://github.com/unclecode/crawl4ai) | Apache-2.0 |
| Optional knowledge service | [onyx-dot-app/onyx](https://github.com/onyx-dot-app/onyx) Community | see that project |
| Documents, audio, and video | [docling-project/docling](https://github.com/docling-project/docling), [microsoft/markitdown](https://github.com/microsoft/markitdown), and faster-whisper for speech | see those projects |
| Scripture text for a reference | [apologist-project/llm-scripture-fidelity](https://github.com/apologist-project/llm-scripture-fidelity) | CC0 |
| Voice | a LiveKit adapter on this same HTTP API | |

V0 does not crawl the web and does not call Firecrawl, Exa, Tavily, Parallel, Browserbase, or an external chat-agent API.

## License

Project code uses [MIT](LICENSE). The [Contributor Covenant code of conduct](CODE_OF_CONDUCT.md) retains its separate CC BY-SA 4.0 license and attribution. See the [dependency and third-party license inventory](docs/licenses.md).

## Contributing and support

This project is in pre-release development; no versioned public release is declared. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and the pull request process, [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations, and [CHANGELOG.md](CHANGELOG.md) for recorded changes. Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Private security and moderation channels must be configured before public reporting is operational.
