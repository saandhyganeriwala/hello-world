# 2. Recommended Tech Stack

The stack aims for low cost, few moving parts and Shopify App Store compliance.

| Layer | Choice | Why | Rejected alternatives |
|---|---|---|---|
| Shopify app framework | Shopify CLI **React Router app template** (TypeScript, Node 22), `@shopify/shopify-app-react-router`, Polaris web components, App Bridge | Official path. Managed install, token exchange, session tokens and webhooks come pre-wired. Reviewers know it. | Custom Express OAuth (more review risk); Remix template (superseded) |
| Agent and workers | Same TypeScript monorepo, separate worker process | One language, shared GraphQL client and types | Python agent (two codebases) |
| LLM SDK | `@anthropic-ai/sdk`, Messages API, our own loop | Approvals span turns. We need per-call metering and model switching between episodes. | Managed Agents (session runtime billing, per-session containers); OpenAI-compatible shims |
| Models | **Claude Haiku 5.5** (`claude-haiku-5-5`) default. **Claude Sonnet 5.5** (`claude-sonnet-5-5`) on escalation, premium copy and computer use. | Haiku 5.5 costs $0.10/$0.50 per MTok (prompts up to 100K) and handles vision, tools and structured outputs. Sonnet 5.5 costs $2/$10 for harder work. | Opus or Fable (too expensive for ₹499) |
| Database | Postgres 16 (Railway; Neon as an alternative) | Sessions, state, audit, queue all in one store | Mongo, DynamoDB |
| Queue and scheduler | **pg-boss** on the same Postgres | No Redis to run or pay for. Has singleton keys for per-shop ordering and cron schedules. | BullMQ plus Redis (another service), SQS |
| Image service | Python 3.12, FastAPI, **rembg** (MIT) with **`isnet-general-use`** ONNX model (Apache-2.0) on CPU, **pyvips**/Pillow for resize and enhancement, OpenCV for blur checks | Runs on CPU in about 1–2 s per 1024px image. Permissive licences. No GPU. | BRIA RMBG-2.0 (non-commercial licence); `@imgly/background-removal` (AGPL); generative edit APIs (cost, can misrepresent the product) |
| Object storage | Cloudflare R2, 7-day lifecycle rule | Zero egress fees, free tier covers the volume. Only holds transient media; Shopify's CDN hosts the final images. | S3 (egress fees) |
| Hosting | **Railway**, Singapore region: `web` (app and webhooks), `worker` (agent and jobs), `image-svc` (private network only), Postgres | Usage-based pricing, simple deploys, low latency to India, already connected to this workspace | Hetzner VPS with Docker Compose (cheapest, about €15/month, more ops); Fly.io (good, fine for the browser sandbox later) |
| Computer-use sandbox (later, behind flag) | Fly Machines started per task: Playwright Chromium, no persistent disk, egress allowlist `*.myshopify.com`, `admin.shopify.com` | Pay per second, destroyed after each task | Always-on VM |
| Observability | pino JSON logs, Sentry (free tier), `llm_usage` table plus a small cost dashboard in the admin app | Cheap. Cost visibility per merchant. | Full APM |
| Secrets | Railway variables. Shopify tokens encrypted at the app level (AES-256-GCM, key rotation by key id). | Database dumps alone do not expose tokens. | Plaintext tokens |
| CI | GitHub Actions: typecheck, unit tests, agent eval subset, `shopify app deploy` on tag | | |

## Model routing summary (details in doc 05)

| Route | Model | Effort | Typical tokens |
|---|---|---|---|
| Pre-router (buttons, keywords, media debounce) | none | none | 0 |
| Main agent turn | Haiku 5.5 | `low` (raised to `medium` for store-config tasks) | about 8K in (5K cached), about 400 out |
| Listing generation (vision + structured output) | Haiku 5.5 | `medium` | about 5K in, about 1.2K out |
| Premium copy (merchant toggle) | Sonnet 5.5 | `medium` | about 5K in, about 1.2K out |
| Escalated episode | Sonnet 5.5 (server-side refusal fallback on) | `medium` | about 10K in, about 700 out per call |
| Weekly summary, checkout drafts | Haiku 5.5 (daily drafts can use the Batch API at 50% off) | `low` | small |
| Computer use (flagged) | Sonnet 5.5 with `computer_toolset_20260801`, or Haiku 5.5 with `browser_toolset_20260801` once evaluated | `medium` | about 10–15K per step |

## Image pipeline choices

1. **Validate**: MIME type, size, minimum 800px short edge, blur check (variance of the Laplacian). If an image
   fails, warn the merchant and suggest sending it as a *document* (WhatsApp compresses photos sent as images).
2. **Classify (in the listing LLM call)**: each image is tagged `packshot`, `lifestyle` or `detail`, with a
   `remove_background` flag. Background removal only runs on packshots. Lifestyle photos keep their scene.
3. **Background removal**: rembg `isnet-general-use`. `birefnet-general-lite` (MIT) is an option for
   hair and fabric edges at about 3× the CPU time.
4. **Compose**: crop to the subject's bounding box, pad so the subject fills about 85% of the frame,
   place on white (#FFFFFF) or keep transparency on request, 2048×2048 square.
5. **Enhance (conservative)**: gray-world white balance, mild CLAHE on luminance, light unsharp mask.
   Never change product colour or shape, for consumer-protection reasons.
6. **Encode**: JPEG quality 85. Shopify's CDN serves WebP/AVIF itself.
7. **Vision copy**: a 768px version goes to Claude (about 800 image tokens each).
8. **Preview**: a before/after collage goes to WhatsApp. The merchant can reply "keep original" per image.
