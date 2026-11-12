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
   - **command** → CRUD changes the interface: sections, fields, the accent colour, and *views* (below)
   - **chatter** → nothing is recorded
4. The change is applied in one database transaction and every teammate's screen refreshes.

## Views

Every section can be shown many ways: list, table, board (kanban / pipeline, drag cards between columns),
funnel, calendar, agenda, chart (bar, line, area, pie, donut), overview (KPI tiles), tracker (progress to a
goal per day/week/month, streaks), ledger (money in/out, running balance) and top list. All of them take
filters, sorting, grouping, visible fields and highlight rules, and export to CSV.

Each kind of section gets sensible default views from its data. Saved views live on the section
(`sections.views`) and are shared by the team; CRUD adds them ("show my leads as a kanban", "pie chart of
sales by product", "only pending ones"), and so does the Customize button. A new kind of record (say,
water intake) can arrive with its own screen, such as a tracker with a daily goal.

Claude's reply is constrained by a JSON schema (structured outputs), so it is always valid. The schema has
no nullable or optional fields (the API allows at most 16 union-typed and 24 optional parameters per
request): "not set" is `""`, `[]` or `0`; `npx tsx scripts/check-schemas.ts` counts them. The stable
instructions are prompt-cached. If no API key is set, or Claude is unreachable, an on-device parser still
records common orders, payments and leads.

## Run it locally

```bash
npm install
npm run dev          # landing page at http://localhost:3000, app at /app
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

### Email (Brevo — recommended: 300 free emails a day)

1. Sign up at [brevo.com](https://www.brevo.com).
2. *Settings → Senders, Domains & Dedicated IPs → Domains → Add a domain* → `crud.chat` → add the records
   it shows (a `brevo-code` TXT, DKIM, and DMARC) at your DNS host → *Authenticate*.
3. *Settings → SMTP & API → API Keys → Generate a new API key* → set `BREVO_API_KEY` on Railway.
4. *Security → Authorised IPs*: Railway's outgoing address changes, so turn IP blocking off (or calls fail
   with an "unrecognised IP" error).
5. Set `EMAIL_FROM=CRUD.chat <login@crud.chat>` and `OTP_DEV_MODE=false`.

The email is built in `src/auth/email.ts`.

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

## Voice notes

The app records audio and a speech-to-text model on the server writes it out (`src/ai/transcribe.ts`):
OpenAI `gpt-4o-mini-transcribe` (set `OPENAI_API_KEY`), primed with the workspace's names and products,
or Sarvam Saaras v3 for Hinglish and Indian languages (set `SARVAM_API_KEY`). Audio is sent in ≤25-second
segments; the text lands in the composer to check before sending, and its cost comes out of the AI credit.
Without a key, the browser's built-in speech recognition is used.

## Plans, usage and payments

Every Claude call is priced from its token counts (input, output, cache reads and writes, at the
model's per-million prices in `src/domain/billing.ts`) and stored in `ai_usage` against the workspace.

| Plan | Price | AI | People |
|---|---|---|---|
| Free | ₹0 / $0 | 10 AI actions per person, once (`FREE_ACTIONS`) | 3 (`FREE_MEMBERS`) |
| Pro | ₹499 in India / $6 elsewhere, a month, renews automatically (`PRO_PRICE_INR`, `PRO_PRICE_USD`) | fair use: ₹225 of AI a month (`PRO_MONTHLY_AI_INR`), shown as ≈ 500 actions | 10 (`PRO_MEMBERS`) |

A typical action costs about ₹0.35–0.45 (measured in production: ~700 new tokens in, ~250 out, the
6,300-token instructions read from Claude's one-hour prompt cache). Free actions belong to the person,
across all the free workspaces they own (a voice transcription isn't an action of its own); upgrading early
carries what's left into the first Pro month. Prices show in rupees in India and dollars elsewhere (by time
zone, or Cloudflare's country header); USD checkout needs International Payments on Razorpay and
`RAZORPAY_INTERNATIONAL=true`.

When a workspace runs out, CRUD still saves plain records with the on-device parser; questions,
screenshots, imports and interface changes ask for an upgrade. Viewing, editing and searching never cost.
The *Plan & usage* screen (menu → Plan & usage) shows what's used and what's left.

**Razorpay Subscriptions** (Pro renews every month until cancelled):
1. Razorpay Dashboard → *Account & Settings → API Keys* → generate keys (use **Test Mode** first) →
   set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` on Railway.
2. Make sure **Subscriptions** is enabled on the account (Dashboard → *Subscriptions*). The monthly plan
   is created automatically on the first checkout and remembered (`razorpay_plans`); to use a plan you made
   in the dashboard instead, set `RAZORPAY_PLAN_ID_INR` / `RAZORPAY_PLAN_ID_USD`. A price change creates a new plan.
3. *Account & Settings → Webhooks → Add New Webhook* → URL `https://crud.chat/api/billing/razorpay-webhook`,
   a secret of your choice (→ `RAZORPAY_WEBHOOK_SECRET`), events **subscription.activated**, **subscription.charged**,
   **subscription.pending**, **subscription.halted**, **subscription.cancelled**, **subscription.completed**,
   **subscription.paused**, **subscription.resumed**.
4. Test with a test card, then switch to live keys (and add the webhook again in Live Mode).

How it runs: *Subscribe* creates a subscription; Checkout takes the first payment and sets up the mandate
(card or UPI Autopay); the browser's signed response (`payment_id|subscription_id`) switches the workspace to
Pro for the period Razorpay reports. Each `subscription.charged` webhook starts the next month (usage resets,
carried-over free actions end). Pro stays on `PRO_GRACE_DAYS` (3) past a renewal date while Razorpay retries a
failed charge; `halted` ends it. *Cancel subscription* (Plan & usage) cancels at the end of the paid month — no
refunds for a started period. Every charge is counted once per payment id. Code: `src/routes/billing.ts`,
`src/domain/billing.ts`.

**Policy pages** (Razorpay's website checks): `/terms`, `/privacy`, `/refunds`, `/contact`, `/shipping` —
static files in `public/`, linked from the landing page footer.

## Mobile apps

iOS and Android apps live in `mobile/` (a Capacitor 8 shell around crud.chat/app). Builds, store setup and
release steps are in [mobile/README.md](mobile/README.md). The website is also installable (manifest, icons and an
offline page via `public/sw.js`). Inside the apps Pro is bought through the App Store / Google Play
(`src/domain/iap.ts`, verified server-side, renewals via store notifications); Razorpay stays on the web.
Delete account (menu) and `/delete-account` meet the stores' deletion rules; `REVIEW_LOGIN` gives reviewers a login.

## SEO & blog

- **Blog**: write Markdown in `content/blog/<slug>.md` (front matter: `title`, `description`, `date`, `keywords`).
  Posts are rendered server-side at `/blog/<slug>` with canonical URLs, Open Graph tags and `BlogPosting` +
  breadcrumb structured data, and are added to `/sitemap.xml`, `/blog/rss.xml` and `/llms.txt` automatically.
- **Landing page**: keyword title/description, canonical, share image (`public/og.png`), JSON-LD for
  Organization, WebSite, SoftwareApplication (with prices) and an FAQ that matches the visible FAQ section.
- **For crawlers**: `/robots.txt` (blocks `/app`, `/admin`, `/api/`), `/sitemap.xml`, `/llms.txt` (a plain summary
  for AI assistants), real 404s for unknown pages, gzip on pages. `SITE_URL` overrides `https://crud.chat`.
- Code: `src/routes/seo.ts`, `public/blog.css`, `public/404.html`.

## Analytics (admin)

`/admin` is a dashboard for the team running CRUD.chat: visitors, signups, the signup → workspace → AI →
free limit → subscription funnel, active people, workspaces per person and people per workspace, AI actions
per person (average, median, 75th/90th/99th percentile), AI cost, subscriptions, MRR, revenue, traffic
sources (referrers, `?utm_source=` campaigns) and the most active workspaces. Pick 7 / 30 / 90 days or all time.

- Set `ADMIN_EMAILS` (comma-separated login emails) on the server; those people see *Analytics* in the app menu.
- Visits are counted by a small beacon on every page (`POST /api/t`) without cookies: a one-way hash of IP +
  browser, bots skipped (`page_views`). Countries need a CDN that sends `cf-ipcountry` (e.g. Cloudflare).
- Code: `src/domain/analytics.ts`, `src/routes/admin.ts`, `public/admin.html`.

## Costs

Each Claude call logs one JSON line with its token counts, e.g.
`{"ai":"understand","model":"claude-sonnet-5-5","ms":2400,"in":1800,"out":160,"cacheRead":2100,...}`.
Use those to see real per-message cost. Levers: `CLAUDE_EFFORT_CHAT`, the snapshot size
(`SNAPSHOT_RECORDS` in `src/domain/apply.ts`), and the model.

## Layout

```
public/index.html        the landing page (served at /)
public/app.html          the app (served at /app; mobile-first, no build step)
src/server.ts            HTTP server: static files + /api
src/routes/api.ts        every API route (auth, workspaces, team, messages, import, records, live events)
src/domain/messages.ts   the message flow above
src/domain/apply.ts      record operations + interface commands (transactional)
src/domain/views.ts      saved views: sanitising, adding, removing
src/domain/import.ts     spreadsheet import
src/ai/                  Claude client, prompts, structured-output schemas
src/auth/                OTP, email (Resend), WhatsApp (Interakt), sessions
src/db/                  schema + connection (Postgres or embedded PGlite)
drizzle/                 SQL migrations
```
