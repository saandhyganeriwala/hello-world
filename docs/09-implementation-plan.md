# 9. Implementation Plan

Assumes 1–2 engineers. Each milestone ends with something demoable on a development store.

## Prerequisites (owner: you, needs your accounts)

- [ ] Shopify Partner account, a development store (with test data), and the app created in the Partner Dashboard
- [ ] Meta Business Manager, business verification started (takes days to weeks), developer app, WABA, test number, then the production number
- [ ] Claude Console: a dedicated **production workspace** and API key, paid with Platform usage credits, with a workspace spend limit; a separate dev workspace
- [ ] Railway project (Singapore), Cloudflare R2 bucket, Sentry project
- [ ] Brand name, domain, privacy policy and terms (needed for both the Meta and Shopify reviews)

## Milestones

| # | Weeks | Milestone | Exit criteria |
|---|---|---|---|
| M0 | 1 | **Scaffold**: monorepo, Shopify CLI React Router template, Prisma/Postgres, pg-boss worker, CI (typecheck, tests), Railway deploy, secrets | `shopify app dev` loads the embedded app on the dev store; worker processes a test job |
| M1 | 2–3 | **Shopify foundation**: managed install + token exchange, encrypted offline tokens with refresh, compliance and uninstall webhooks, GraphQL client with cost-aware throttle, codegen'd typed operations, Managed Pricing in test mode | Install/uninstall/reinstall clean; throttle test at 2× restore rate shows no errors; GDPR webhooks pass the CLI trigger tests |
| M2 | 3–4 | **WhatsApp channel**: webhook verify and HMAC, dedupe, per-shop serial queue, wa.me linking, sender (text, buttons, list, image), media downloader to R2, read receipt and typing indicator, templates submitted | A merchant links a phone from the admin app; echo bot round-trip under 2 s; replayed webhook is ignored |
| M3 | 4–6 | **Agent core**: Messages API loop, tool router with tiers, pending actions and button approvals, audit log, UNDO, `llm_usage` metering and budget guard, episodes and summaries, read tools + generic GraphQL query, admin simulator, eval harness (first 30 cases) | "How many orders this week?" and "Change price of X to 999" (with approval) work end to end; usage dashboard shows cost per turn; evals pass at ≥ 90% |
| M4 | 6–8 | **Product creation**: media batching, image service (rembg isnet + vips, quality checks), listing call with structured output, staged uploads, productCreate/variants, preview loop, publish approval | Photos plus "kurta 799 S M L" become a published product with clean images in < 90 s; median LLM cost per listing < $0.003 on Haiku |
| M5 | 8–9 | **Store config**: shipping rates (delivery profiles), discounts, pages, menus, Theme App Extension banner (block + embed + deep links), optional-scope grant flow, guided-fallback playbooks (top 10 topics) | "Free shipping above 999", "Add Diwali banner till Sunday" and "Change theme colour" (guided) all behave correctly |
| M6 | 10 | **Insights**: weekly summary job + template, daily abandoned-checkout digest, recovery drafts with wa.me links, protected customer data request filed | Monday summary arrives on schedule; drafts open WhatsApp with the text pre-filled |
| M7 | 10–12 | **Hardening and submission**: security review (token handling, tenant isolation tests, prompt-injection suite), load test (500 merchants simulated), data retention jobs, App Store listing, screencast, reviewer test instructions + demo WhatsApp number + simulator, Built for Shopify checklist | Submitted to the App Store; Meta number at production tier |
| M8 | after launch | Unmet-need review → new typed tools; Hindi templates; Embedded Signup (Tech Provider) for customer messaging; computer-use pilot on internal stores only, after the policy check | Rung c/d volume falls each month |

## First sprint (M0 + start of M1), concrete tasks

1. `shopify app init` with the React Router template in `apps/shopify-app` (needs your Partner login, which I can't do from here).
2. Add `packages/db` with the Prisma schema from doc 01 §1.5 and migrations. Point session storage at Postgres.
3. Add `apps/worker` with pg-boss: `inbound`, `agent`, `media`, `schedule` queues; `singletonKey` per shop.
4. `packages/shopify/graphql.ts`: client wrapper reading `extensions.cost.throttleStatus`, per-shop bucket, `THROTTLED` backoff,
   typed operations via `@shopify/api-codegen-preset`.
5. Token encryption helper (AES-256-GCM, key id prefix) and token refresh job.
6. Webhook routes: `app/uninstalled`, compliance topics, `app_subscriptions/update`.
7. `packages/agent`: copy in `agent/tools.ts` and the system prompt; implement `routeTool` for 3 read tools; unit tests for tier enforcement.
8. CI: typecheck, vitest, Prisma migrate check, schema validation of all `.graphql` documents against the pinned Admin API version.
9. Railway: `web`, `worker`, Postgres; health checks; Sentry.

## Definition of done (every feature)

- Typed tool with zod validation and tier assigned; audit event written; undo path defined (or tier D)
- At least 3 eval cases, including one adversarial
- Tokens per task recorded in `llm_usage` and compared to the cost model
- Works in English and Hindi
