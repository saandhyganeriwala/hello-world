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

No setup needed: without `DATABASE_URL` it uses an embedded Postgres in `.data/`, and without email
(Resend) credentials the login code is shown on screen. Add `ANTHROPIC_API_KEY` to a `.env` file (see
`.env.example`) to turn on Claude.

| Script | What it does |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm run build` / `npm start` | Compile and run the production build |
| `npm run typecheck` | Type-check |
| `npm run smoke` | Test the record + command engine against a throwaway database |
| `npx tsx scripts/check-schemas.ts` | Validate the JSON schemas sent to Claude |
| `npm run db:generate` | Create a migration after changing `src/db/schema.ts` (applied on boot) |

## Deploy on Railway (app + Postgres in one place)

1. **Account** — sign up at [railway.com](https://railway.com) with GitHub and choose the Hobby plan
   ($5/month, includes $5 of usage).
2. **App** — *New Project → Deploy from GitHub repo* → allow Railway access to this repository → pick it.
   Railway builds from the `Dockerfile`. If the code isn't on the default branch yet, open the service →
   *Settings → Source* and pick the branch. The first deploy will crash: it has no settings yet.
3. **Database** — on the project canvas: *Create → Database → Add PostgreSQL*.
4. **Settings** — open the app service → *Variables → Raw Editor*, paste and fill in:
   ```
   NODE_ENV=production
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   SESSION_SECRET=<a long random string>
   ANTHROPIC_API_KEY=<from console.anthropic.com>
   LOGIN_METHOD=email
   RESEND_API_KEY=<from resend.com>
   EMAIL_FROM=CRUD.chat <login@crud.chat>
   OTP_DEV_MODE=false
   ```
   (`${{Postgres.DATABASE_URL}}` links the database; use the database service's name if you renamed it.
   Make a secret with `openssl rand -hex 32`, or a password manager's 40+ character password.)
   Click **Deploy** to apply the changes.
5. **Health check** — *Settings → Deploy → Healthcheck Path* = `/api/health`. Optionally pick a region near
   your users (e.g. Singapore for India) under the same section.
6. **Address** — *Settings → Networking → Generate Domain* gives you `something.up.railway.app`. If it asks
   for a port, use the one in the deploy log line `CRUD.chat listening on http://localhost:<port>`.
7. **Your domain** — *Settings → Networking → Custom Domain* → `crud.chat` → add the DNS record Railway shows
   at your domain registrar. A bare domain (`crud.chat`, not `app.crud.chat`) needs a DNS host that
   supports CNAME flattening/ALIAS records, such as Cloudflare.
8. **Check** — open the address, log in, record something. *Deployments → View logs* shows
   `[config] login by email` at start and one line per Claude call.

Migrations run automatically on start. The app is one process; it can run on Render or Fly.io from the
same Dockerfile. Live updates use an in-process event bus, so run a **single instance** until that is
moved to Postgres LISTEN/NOTIFY or Redis.

## Login

`LOGIN_METHOD` picks how people log in: `email` (default) or `whatsapp`. Either way codes are 6 digits,
expire after 10 minutes, are stored hashed, allow 5 tries, and are rate-limited (30 s between sends,
5 per hour per address). Teammates are invited by the same kind of address. Pick one method before real
users sign up — an email account and a phone account are separate people.

To test before either is set up, set `OTP_DEV_MODE=true`: the code is shown on screen. Turn it off for
real users.

### Email (Resend)

1. Sign up at [resend.com](https://resend.com) (free tier: 3,000 emails/month).
2. *Domains → Add Domain* → `crud.chat` → add the DNS records it shows at your registrar → *Verify*.
   Until the domain is verified, Resend only delivers to your own sign-up address.
3. *API Keys → Create API Key* (sending access) → set `RESEND_API_KEY`.
4. Set `EMAIL_FROM` to an address on that domain, e.g. `CRUD.chat <login@crud.chat>`.

The email is built in `src/auth/email.ts`.

### WhatsApp (Interakt)

1. Connect your WhatsApp Business number in Interakt.
2. Create a template, category **Authentication**, with the code as its one variable
   (e.g. `{{1}} is your CRUD.chat code.`) and, ideally, a **Copy code** button. Wait for Meta's approval.
3. Copy the API key from **Interakt → Settings → Developer Setting**.
4. Set `LOGIN_METHOD=whatsapp`, `INTERAKT_API_KEY`, `INTERAKT_OTP_TEMPLATE` (the template's exact name),
   `INTERAKT_TEMPLATE_LANG` (usually `en`), and `INTERAKT_OTP_BUTTON` (`true` if the template has the button).

The request is built in `src/auth/interakt.ts`.

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
src/auth/                OTP, email (Resend), WhatsApp (Interakt), sessions
src/db/                  schema + connection (Postgres or embedded PGlite)
drizzle/                 SQL migrations
```
