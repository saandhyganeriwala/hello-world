# CRUD.chat

Type or speak — your business records organise themselves. A team records orders, payments, leads and
anything else in a shared chat; Claude turns each message into structured records and builds the right
interface (order panel, ledger, CRM, task list…) on the fly.

## How a message flows

1. A team member sends text, a screenshot, or a spreadsheet.
2. The server saves the message and tells teammates (live, over Server-Sent Events).
3. Claude (Sonnet 5.5) reads it with a snapshot of the workspace and decides what it is:
   - **record** → create / update / delete records (and new sections when needed)
   - **question** → CRUD answers in the chat; nothing is recorded
   - **command** → CRUD changes the interface (rename/merge/sort sections, fields, accent colour…)
   - **chatter** → nothing is recorded
4. The change is applied in one database transaction and every teammate's screen refreshes.

Claude's reply is constrained by a JSON schema (structured outputs), so it is always valid. The stable
instructions are prompt-cached. If no API key is set, or Claude is unreachable, an on-device parser still
records common orders, payments and leads.

## Run it locally

```bash
npm install
npm run dev          # http://localhost:3000
```

No setup needed: without `DATABASE_URL` it uses an embedded Postgres in `.data/`, and without Interakt
credentials the login code is shown on screen. Add `ANTHROPIC_API_KEY` to a `.env` file (see
`.env.example`) to turn on Claude.

| Script | What it does |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm run build` / `npm start` | Compile and run the production build |
| `npm run typecheck` | Type-check |
| `npm run smoke` | Test the record + command engine against a throwaway database |
| `npx tsx scripts/check-schemas.ts` | Validate the JSON schemas sent to Claude |
| `npm run db:generate` | Create a migration after changing `src/db/schema.ts` (applied on boot) |

## Deploy (Railway — app + Postgres in one place)

1. Push this repository to GitHub.
2. In [Railway](https://railway.com): **New Project → Deploy from GitHub repo** → pick this repo.
   It builds with the included `Dockerfile`.
3. In the project: **+ New → Database → PostgreSQL**.
4. On the app service → **Variables**, add:
   - `DATABASE_URL` → reference the Postgres service's `DATABASE_URL`
   - `SESSION_SECRET` → a long random string
   - `ANTHROPIC_API_KEY` → from console.anthropic.com
   - `NODE_ENV` = `production`
   - Interakt variables (below), **or** `OTP_DEV_MODE=true` to test before Interakt is ready
5. **Settings → Networking → Generate Domain** (or add `crud.chat` as a custom domain and point its DNS
   at Railway). Set the health check path to `/api/health`.

Migrations run automatically on start. The app is one process; it can run on Render or Fly.io from the
same Dockerfile. Live updates use an in-process event bus, so run a **single instance** until that is
moved to Postgres LISTEN/NOTIFY or Redis.

## WhatsApp login (Interakt)

1. Connect your WhatsApp Business number in Interakt.
2. Create a template, category **Authentication**, with the code as its one variable
   (e.g. `{{1}} is your CRUD.chat code.`) and, ideally, a **Copy code** button. Wait for Meta's approval.
3. Copy the API key from **Interakt → Settings → Developer Setting**.
4. Set `INTERAKT_API_KEY`, `INTERAKT_OTP_TEMPLATE` (the template's exact name), `INTERAKT_TEMPLATE_LANG`
   (usually `en`), and `INTERAKT_OTP_BUTTON` (`true` if the template has the button). Set `OTP_DEV_MODE=false`.

The request is built in `src/auth/interakt.ts`. Codes are 6 digits, expire after 10 minutes, are stored
hashed, allow 5 tries, and are rate-limited (30 s between sends, 5 per hour per number).

## Costs

Each Claude call logs one JSON line with its token counts, e.g.
`{"ai":"understand","model":"claude-sonnet-5-5","ms":2400,"in":1800,"out":160,"cacheRead":2100,...}`.
Use those to see real per-message cost. Levers: `CLAUDE_EFFORT_CHAT`, the snapshot size
(`SNAPSHOT_RECORDS` in `src/domain/apply.ts`), and the model.

## Layout

```
public/index.html        the app (mobile-first, no build step)
src/server.ts            HTTP server: static files + /api
src/routes/api.ts        every API route (auth, workspaces, team, messages, import, records, live events)
src/domain/messages.ts   the message flow above
src/domain/apply.ts      record operations + interface commands (transactional)
src/domain/import.ts     spreadsheet import
src/ai/                  Claude client, prompts, structured-output schemas
src/auth/                OTP, Interakt, sessions
src/db/                  schema + connection (Postgres or embedded PGlite)
drizzle/                 SQL migrations
```
