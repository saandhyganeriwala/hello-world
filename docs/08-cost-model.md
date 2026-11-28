# 8. Cost Model at ₹499/month

All numbers are planning estimates. Replace them with measured tokens per task from the eval set (doc 05 §5.9)
and the first 50 merchants. Check the Claude pricing page, Meta's WhatsApp rate card for India and Shopify's
Partner terms before committing to a price.

## 8.1 Assumptions

| Item | Value |
|---|---|
| FX | ₹88 = $1 |
| Claude Haiku 5.5 | $0.10 input, $0.50 output per MTok (prompts ≤ 100K); cache read 0.1×, 5-minute cache write 1.25× |
| Claude Sonnet 5.5 | $2 input, $10 output per MTok; cache read $0.10/MTok |
| Shared prefix (tools + system prompt) | about 5,000 tokens, warm across all merchants |
| WhatsApp (India) | Merchant-initiated service messages: free. Utility template: about ₹0.12 (assumed). Marketing: about ₹0.88 (assumed, not used by us in v1). |
| Shopify revenue share | 0% on the first $1M lifetime (after registering for the reduced plan), 15% after. Assume about 3% payment processing (verify). |
| Shopify billing currency | USD. ₹499 ≈ $5.67, so the plan would be $5.49–$5.99. Check whether local-currency app pricing is available for India. |
| GST | Depends on how the business and Shopify's payouts are structured. Shown as a separate scenario. Ask a CA. |

## 8.2 LLM cost per merchant per month

**Typical merchant**: 200 agent turns, 40 new products, 15 escalated episodes, 4 weekly summaries, daily checkout drafts.

| Workload | Calculation | USD |
|---|---|---|
| Haiku agent calls (400 = 200 turns × 2) | per call: 5K cache read ($0.00005) + 1.5K history cache read ($0.00002) + 1.5K new at cache-write rate ($0.00019) + 450 out incl. thinking ($0.00023) ≈ $0.00048 | 0.19 |
| Listing generation (40) | 4 images × ~800 + 1.5K prompt ≈ 4.7K in ($0.00047) + 1.2K out ($0.0006) | 0.04 |
| Sonnet escalations (15 episodes × 3 calls) | per call: 5K cache read ($0.0005) + 4K new ($0.01) + 700 out ($0.007) ≈ $0.0175 | 0.79 |
| Weekly summaries (4) | 8K in + 600 out on Haiku | 0.01 |
| Checkout recovery drafts (30 daily runs) | 3K in + 800 out on Haiku; half price on the Batch API | 0.02 |
| Overhead (retries, validation errors), +10% | | 0.10 |
| **Total** | | **≈ $1.15 (₹101)** |

| Profile | Usage | LLM cost |
|---|---|---|
| Light | 50 turns, 10 products, 3 escalations | ≈ $0.25 (₹22) |
| Typical | as above | ≈ $1.15 (₹101) |
| Heavy | 600 turns, 150 products, 30 escalations, premium copy on 50 | ≈ $3.40, **capped at $2.50 (₹220)** by the budget guard (no escalation or premium copy after 80%) |

**Escalations are about 70% of LLM spend.** Getting Haiku to handle more (better tools, effort `medium` on config
tasks) matters more than any other lever. Cutting escalations from 15 to 5 brings the typical cost to about ₹45.

## 8.3 Other costs per merchant per month

| Item | Estimate |
|---|---|
| WhatsApp: about 8 utility templates outside the 24 h window (summaries, reminders) | ≈ ₹1 |
| WhatsApp: merchant chat (service, inside window) | ₹0 |
| WhatsApp: customer recovery messages | ₹0 to us (v1 sent from the merchant's own WhatsApp; v2 billed to the merchant's own WABA) |
| Infra: Railway web + worker + image service + Postgres ≈ $75/month fixed | ₹66 at 100 merchants · ₹22 at 300 · ₹16 at 1,000 (≈ $180/month) |
| Image processing CPU (160 images × ~2 s) | negligible, included above |
| R2, Sentry, logs | free tiers at this scale |
| Support tooling, email, domain, misc | ≈ ₹15 |

## 8.4 Unit economics (typical merchant, 300 merchants)

| Line | ₹ |
|---|---|
| Price | 499 |
| Payment processing (~3%) | −15 |
| Shopify revenue share (first $1M lifetime) | 0 |
| LLM | −101 |
| WhatsApp | −1 |
| Infra | −22 |
| Misc | −15 |
| **Contribution before GST** | **≈ 345 (69%)** |
| If 18% GST comes out of the ₹499 | −76 → **≈ 269 (54%)** |

**Stress case**: a heavy merchant at the LLM cap, only 100 merchants, GST applicable and 15% revenue share:
499 − 76 − 75 − 15 − 220 − 2 − 66 − 15 = **≈ ₹30**. Still positive. The budget cap is what keeps it there.

**Break-even on fixed infra** (about ₹6,600/month): about 20 paying merchants (excludes salaries).

## 8.5 Computer use (if ever enabled)

Sonnet 5.5, about 25 steps per task. Per step: 10K cache read ($0.001) + 2K new with screenshot ($0.005) +
300 out ($0.003) ≈ $0.009, so **about $0.23 (₹20) per task** plus a few paise of machine time. Three included
tasks would add about ₹60 per merchant, which is why it sits behind a quota and a usage charge (for example
₹49 per extra task). Haiku 5.5 with the browser toolset could cut this a lot. Evaluate it first.

## 8.6 Levers if margins tighten

1. Fewer escalations (better typed tools, prompt tuning, effort `medium` before switching models).
2. Batch API for every non-interactive job (summaries, drafts): 50% off.
3. A smaller merchant context block (summaries of the last 3 episodes, not 10).
4. A Hetzner VPS instead of Railway once traffic is steady: infra ≈ ₹5 per merchant at 300.
5. Premium copy as a paid add-on rather than a toggle.
