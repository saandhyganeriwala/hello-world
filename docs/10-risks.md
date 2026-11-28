# 10. Risks, App Store Review Concerns and Mitigations

## 10.1 Shopify App Store review

| Risk | Likelihood | Mitigation |
|---|---|---|
| Reviewer can't test because the app is WhatsApp-only | High | In-admin **simulator** that runs the same pipeline; a demo WhatsApp number; step-by-step test instructions and a screencast in the submission |
| "App must provide value inside Shopify admin" | Medium | Real embedded screens: approvals, activity log with undo, settings, usage, setup checklist (doc 07 §7.4) |
| Computer use / admin automation seen as scraping or credential use | High if shipped | Not in the App Store build. Flagged, internal only, pending written confirmation from Shopify (doc 06) |
| Theme code modification | High if attempted | No `write_themes`. Storefront changes only through a Theme App Extension plus app metafields |
| Excessive scopes | Medium | Minimal install scopes; others as optional scopes requested in context, with the reason shown |
| Protected customer data (abandoned checkout names and phones) | Medium | File the PCD request early with a clear purpose; data minimisation (phones never sent to the LLM; the wa.me link is built server-side); encryption at rest; retention limits; the feature degrades gracefully until approval |
| Billing outside Shopify | High if done | Managed Pricing / Billing API only |
| Missing GDPR webhooks or slow uninstall cleanup | Low | Implemented in M1 and tested with CLI triggers |
| AI-generated content misrepresents products | Medium | Drafts by default; publish needs approval; prompt forbids unstated claims; `assumptions[]` shown to the merchant; conservative image enhancement (no generative edits) |
| Built for Shopify performance criteria | Medium | Server-side data loading, small bundle, measured in CI with Lighthouse |

## 10.2 Meta / WhatsApp

| Risk | Mitigation |
|---|---|
| Business verification or display-name delays | Start in week 1. Use the test number for development. |
| Template rejected or recategorised as marketing | Purely informational wording; submit early; allow merchants to turn templates off |
| Number quality rating drops (merchants block or report) | Only merchants who linked their number can reach us; nothing promotional; quality monitoring with alerts |
| Platform number outage or ban affects every merchant | Keep a second verified number ready; the admin simulator works as a fallback channel |
| Customer messaging consent | v1: merchant sends from their own WhatsApp; v2: templates only to opted-in customers through the merchant's own WABA |
| Graph API version deprecations | Pin the version; check deprecations each quarter |

## 10.3 Security and safety

| Risk | Mitigation |
|---|---|
| Wrong merchant controls a shop (SIM swap, shared phone) | Number bound through a code generated in the admin app; owner and staff roles; owners can revoke; tier D needs an owner; optional "approve high-impact changes in admin only" |
| Cross-tenant data leak | Shop id taken from the binding, never from model output; every DB query scoped by `shop_id` (Postgres row-level security as defence in depth); tenant isolation tests in CI |
| Prompt injection through product data, checkout notes or customer names | Tool results marked as data in the prompt; customer free text never placed in system blocks; high-impact actions need human approval whatever the model says; frozen operations mean the model can't change what was approved; injection cases in the eval suite |
| Model sends a malformed or harmful GraphQL mutation | Typed tools first; the generic mutation tool is allowlisted, schema-validated and always approved |
| Token theft | Tokens encrypted at the app level; least privilege; key rotation; no tokens in logs |
| Runaway API spend from bugs or loops | Per-shop budget guard; max tool rounds; workspace spend limit in the Claude Console; alerts on hourly spend |
| Webhook spoofing | HMAC checks on both Shopify and Meta webhooks; replay dedupe |

## 10.4 Product and business

| Risk | Mitigation |
|---|---|
| LLM cost per merchant above plan | Budget cap with graceful degradation; escalation-rate tracking; usage add-on |
| Background removal quality on hard products (jewellery, transparent items) | Packshot classification; per-image "keep original"; BiRefNet-lite option; merchant preview before publish |
| Hindi and Hinglish quality on a small model | Included in evals from M3; escalation path; templates in both languages |
| Shopify API changes (product model, abandoned checkouts, ShopifyQL availability) | Pinned versions; schema validation in CI; quarterly upgrade task |
| Indian data protection (DPDP Act 2023) | Data map, retention limits, deletion on uninstall, privacy policy naming the processors (Anthropic, Meta, Railway, Cloudflare) |
| Dependence on a single LLM provider | All model calls go through one internal interface; cost and quality tracked per route |

## 10.5 Things to verify early (assumptions in these docs)

1. Exact scope needed by `abandonedCheckouts` in the pinned API version.
2. Whether `shopifyqlQuery` is available in the pinned version (affects sessions and conversion in summaries).
3. Expiring offline token requirements and timeline for new public apps.
4. Shopify's position on admin UI automation (written answer from Partner Support).
5. Current Meta India per-message rates for utility templates.
6. Local-currency (INR) pricing support in Shopify app billing.
7. Shopify payment processing fee on app revenue, and the GST treatment of payouts.
