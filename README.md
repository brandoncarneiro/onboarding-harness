# Onboarding harness

A free, self-hosted intake harness for one church or Christian organization. One install serves one organization. The organization supplies its own record schema and its own pages.

V0 is one conversation that saves a record. A person can finish it in Telegram, in the plain web chat, or by phone and iMessage. Telegram is the channel that runs without a Mac. Phone and iMessage need the Mac that is signed into Messages.

The checked-in example is a fictional local church, Example Community Church. No customer is represented here.

## Install

Node 24 is required.

```bash
nvm use
npm install
cp .env.example .env
npm start
```

The server listens on port 8787 unless `PORT` is set. Open `http://127.0.0.1:8787`.

`.env.example` lists setting names only. Put values in `.env`, which is not committed. Tests do not read a model key and do not use the network.

```bash
npm test
npm run typecheck
```

Without `MODEL_API_KEY`, the server uses a local model that repeats a reply the server has already checked. To use your own model, set `MODEL_API_KEY`, `MODEL_BASE_URL`, and `MODEL_NAME` for any API that accepts OpenAI-style chat completions. The model sits behind `LanguageModel` in `src/model.ts`.

## Example Community Church

The demo schema is `fixtures/record.schema.json`. It asks for name, email, mobile, organization name, and city, plus the agreements that schema marks required. Replace that file to change the intake. Field titles come from the schema.

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

## Point Telegram at the webhook

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` in `.env`. Restart the server. Telegram must be able to reach an HTTPS URL on this process.

```bash
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://YOUR_HOST/api/telegram/webhook","secret_token":"YOUR_TELEGRAM_WEBHOOK_SECRET"}'
```

`YOUR_TELEGRAM_WEBHOOK_SECRET` is the same value as `TELEGRAM_WEBHOOK_SECRET`. Telegram sends it in `X-Telegram-Bot-Api-Secret-Token`. A request without that exact secret does not write a session, a record, a link code, or a knowledge row. When the token is set, the server also calls Telegram `sendMessage`. The web page posts to `POST /api/chat` and does not need the bot token.

`GET /health` returns `{"ok":true}`.

One SQLite file, `data/onboarding.sqlite` unless `DATABASE_PATH` is set, holds records, sessions, link codes, and knowledge pages. Search is full text. Each hit has a URL and a passage.

## Phone and iMessage

Phone and iMessage use [openclaw/imsg](https://github.com/openclaw/imsg) (MIT). The harness speaks JSON-RPC 2.0 to an `imsg rpc` child on stdin and stdout. It calls `chats.list`, `messages.history`, `watch.subscribe`, `watch.unsubscribe`, and `send` only. `send` sets `transport` to `applescript`. The harness does not call the IMCore bridge, `imsg launch`, or anything that needs SIP disabled.

OpenClaw is not imported and not required. Install the `imsg` binary on the Mac that is signed into Messages.

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

MIT. See `LICENSE`.
