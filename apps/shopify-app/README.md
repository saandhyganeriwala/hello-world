# Storemate: Shopify app (embedded admin + webhooks)

Built on Shopify's React Router app template (Polaris web components, App Bridge, Prisma).
Design background: [../../docs/README.md](../../docs/README.md).

## What's here

| Area | Files |
|---|---|
| Embedded admin: Home (2-step setup guide, how-to, monthly stats), Activity (approvals, undo), Settings (numbers, preferences, plan, help) | `app/routes/app._index.tsx`, `app.activity.tsx`, `app.settings.tsx`, `app/components/ConnectWhatsApp.tsx` |
| WhatsApp webhook: Meta handshake, HMAC check, dedupe, number linking with one-time codes | `app/routes/webhooks.whatsapp.ts`, `app/lib/whatsapp.server.ts` |
| Shopify webhooks: uninstall cleanup, mandatory compliance topics | `app/routes/webhooks.app.uninstalled.tsx`, `webhooks.compliance.tsx` |
| Approvals and undo: frozen GraphQL operations, run once | `app/lib/actions.server.ts` |
| Theme app extension: storefront banner (app embed, no JavaScript) | `extensions/storefront-banner/` |
| Database schema (Postgres) | `prisma/schema.prisma`, `prisma/migrations/` |
| Agent: system prompt, 22 tools with approval tiers, loop with escalation, budgets and usage logging | `app/agent/` |
| Model providers (Claude, OpenAI), switched by environment variables | `app/agent/llm/` |
| Shopify GraphQL client (rate-limit aware) and the Admin API 2026-10 schema used to validate every operation | `app/agent/shopify/` |
| Product listings from photos (sharp resize, vision copy, staged uploads, variants, publish approval) | `app/agent/listing.server.ts` |
| Background worker: per-conversation job queue in Postgres, turn processing, schedules | `app/jobs/` |
| WhatsApp Cloud API client incl. Groups API; team group lifecycle | `app/lib/whatsapp-api.server.ts`, `app/lib/groups.server.ts` |
| Plans (Solo / Group) and feature gating | `app/lib/plans.ts`, `app/routes/app.plan.tsx` |
| Screen previews with sample data (development only) | `/dev/preview/home-new`, `/home`, `/home-group`, `/home-group-new`, `/activity`, `/settings`, `/settings-group`, `/plan` |

## How a WhatsApp message is handled

1. `webhooks.whatsapp.ts` checks Meta's signature, stores the message (deduplicated) and schedules a turn for the
   conversation (`dm:<number>` or `group:<id>`), with a short debounce so several photos become one turn.
2. The worker (`app/jobs/worker.server.ts`, started in `entry.server.tsx`) runs one conversation at a time, in order.
3. `turn.server.ts` handles approvals (buttons in chats, `YES 1234` in groups), UNDO and HELP without the model,
   ignores group messages that don't mention Storemate, downloads photos, then runs the agent.
4. `loop.server.ts` calls the model, runs tools, records cost, escalates when needed. High-impact changes become
   pending actions; their approval prompts are sent after the reply. Approval runs the frozen operations directly.

## Merchant setup flow

1. **Connect WhatsApp** (required). The setup card shows a button that opens WhatsApp with
   `LINK-XXXXXX` prefilled, plus a QR code for desktop. The page polls `/app/status` and turns green once the
   message arrives.
2. **Show banners on your store** (optional). Deep link to the theme editor with the app embed pre-activated.
   The page re-checks `config/settings_data.json` (read_themes) when the merchant comes back. It can be skipped.

The setup guide can be hidden once complete and brought back from the Home sidebar.

## Run locally

```bash
cp .env.example .env            # fill in DATABASE_URL at minimum
npm install
npx prisma migrate deploy
npm run dev                      # shopify app dev: needs your Partner account and a dev store
```

Without Partner credentials you can still check the screens:

```bash
SHOPIFY_API_KEY=dummy SHOPIFY_API_SECRET=dummy SHOPIFY_APP_URL=http://localhost:3456 \
  npx react-router dev --port 3456
# open http://localhost:3456/dev/preview/home-new
```

Without the `WHATSAPP_*` variables, outgoing WhatsApp messages are logged, not sent, and group creation is
simulated. In development the connect step has a "Simulate" button that links a test number.

To try the agent without a store, set `FAKE_SHOPIFY_STORE=1` (development only: an in-memory store with a few
products, orders and checkouts) and `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, then send signed webhooks to
`/webhooks/whatsapp` (see `app/jobs/pipeline.integration.test.ts` for the payload shapes).

## Checks

```bash
npm run typecheck && npm run lint && npx vitest run && npm run build
# The pipeline test needs Postgres:
DATABASE_URL=postgresql://... npx vitest run app/jobs
```

The tests validate every GraphQL operation and every change the agent can propose against Shopify's Admin API
schema (version 2026-10), test both model adapters, and run the WhatsApp → queue → agent → approval → undo
pipeline (with a scripted model stand-in) against a real database.

## Notes for Polaris web components with React 18

React 18 sets props on custom elements as attributes, and any attribute value (including `"false"`) counts
as on. Render boolean attributes only when true: `{...(busy ? { loading: true } : {})}`. For initial form
values use `checked` on `s-switch`, `selected` on `s-choice`, and `selected` on the chosen `s-option` (an
`s-select`'s `value` attribute is ignored).

## Built for Shopify: what this build covers

Written from the published requirements as known at build time. Re-check against
https://shopify.dev/docs/apps/launch/built-for-shopify/requirements before submitting.

- Embedded in the admin with App Bridge; navigation through `s-app-nav`; session-token auth (template default)
- Polaris web components only, no custom colours; works at phone width
- Setup guide on the app home with progress, one primary action per step, dismissible when complete
- Contextual save bar on the settings form (`data-save-bar`), confirmation modal for removing a number
- Theme app extension (app embed) instead of script tags or theme code edits; banner CSS is under 1 KB with no JS
- Shopify billing link (Managed Pricing) in Settings; support contact in Settings
- Mandatory compliance webhooks and uninstall cleanup
- Still to do before submission: measure admin web vitals (LCP, CLS, INP) and storefront Lighthouse impact on a
  real store; the install and review thresholds are only reachable after launch
