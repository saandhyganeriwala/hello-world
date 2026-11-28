# 11. WhatsApp groups, plans and switching LLMs

## 11.1 WhatsApp Groups API: what Meta allows (checked against Meta's docs, Nov 2026)

| Question | Answer |
|---|---|
| Is there an official groups API? | Yes. Meta's Cloud API has a **Groups API** for creating and managing groups and messaging them. |
| Who can use it? | Businesses with an **Official Business Account (OBA)**, the verified "green tick" account. The business number must be on Cloud API, not the WhatsApp Business app. Without OBA the API returns error `131215`. |
| How many people? | **Up to 8 participants** per group. Exceeding it returns error `131204`. One number can create up to 10,000 groups. |
| Can Storemate add people? | **No.** Businesses cannot add participants directly. Storemate creates the group and gets an **invite link** (`https://chat.whatsapp.com/...`) through the `group_lifecycle_update` webhook. People join by tapping the link or scanning its QR code. Optional join approval is supported (we use auto-approve). |
| Can it remove people? | Yes (`DELETE /{group_id}/participants`). A removed person can't rejoin with the invite link. |
| Which message types work in groups? | Text, media, text templates and media templates. **No interactive buttons**, so approvals in groups are typed: `YES 4821`. |
| 24-hour window | Any participant's message opens the window for the whole group. |
| Cost | Billed **per delivered recipient**: one message to a 5-person group counts as 5. Since 1 Oct 2026, Meta also charges for non-template (service) messages beyond a **free tier of 1,000 per business number per month**, shared between one-to-one and group chats. |

So your hypothesis was partly right: a verified (OBA) number can run groups, and the limit is **8 people, not 5–6**. Storemate can't add the numbers itself, though. It creates the group, and members join with the invite link.

Sources: Meta's Groups API get-started, group management, group messaging, webhooks, pricing and error-code pages (developers.facebook.com/documentation/business-messaging/whatsapp/groups/…), and the WhatsApp pricing page.

### How Storemate uses it

1. **Group plan, Home → "Create your team group".** Storemate's number calls `POST /{phone_number_id}/groups` with subject "<Store> × Storemate".
2. Meta's `group_create` webhook carries the group id and invite link. The admin shows the link, a QR code and a "Share on WhatsApp" button, and Storemate sends the link to the owner's chat if their 24-hour window is open (otherwise it uses Meta's Template Library "group invite link" utility template, if configured).
3. `group_participants_add` / `group_participants_remove` keep the member list in Settings current. The first join triggers a short welcome in the group.
4. **In the group, Storemate only answers messages that mention "Storemate", @-mention its number, or reply to one of its messages.** Team chatter is stored but never sent to the model.
5. Approvals in the group are typed (`YES 4821` / `NO 4821`). Deletions still need the owner.
6. Settings → Team group: new invite link (old one stops working), remove member (with confirmation), delete group.

### Things to do on the Meta side

- Get **Official Business Account** status for Storemate's number (apply in WhatsApp Manager after business verification).
- Subscribe the app to the `group_lifecycle_update`, `group_participants_update`, `group_settings_update` and `group_status_update` webhook fields.
- Add the "Group invite link" utility template from the Template Library and set `WHATSAPP_TEMPLATE_GROUP_INVITE`.
- Register `weekly_summary`-style and checkout-digest utility templates for updates sent outside the 24-hour window (`WHATSAPP_TEMPLATE_SUMMARY`, `WHATSAPP_TEMPLATE_CHECKOUT_DIGEST`).

## 11.2 Plans

| | Solo | Group |
|---|---|---|
| Price (set in Partner Dashboard, Managed Pricing) | $5.99/month (≈ ₹499) | $9.99/month |
| One-to-one WhatsApp numbers | 1 | up to 8 |
| Team WhatsApp group (up to 8 people) | – | ✓ |
| Products from photos, prices, stock, shipping, discounts, banners, pages | ✓ | ✓ |
| Ask about sales any time | ✓ | ✓ |
| Daily or weekly sales summaries | – | ✓ |
| Abandoned checkouts: daily digest and follow-up drafts | – | ✓ |
| Monthly assistant (LLM) allowance | $2.50 | $4.00 |

- Plan detection reads `currentAppInstallation.activeSubscriptions`. A subscription name containing "Group" or "Team" maps to Group, anything else to Solo. The plan is cached on the shop and refreshed by the `app_subscriptions/update` webhook.
- Gating is in one file (`app/lib/plans.ts`) and applies everywhere: admin screens, agent tools (`plan_required` result) and the scheduler.
- Prices and allowances are environment variables (`PLAN_SOLO_PRICE_USD`, `PLAN_GROUP_PRICE_USD`, `PLAN_*_LLM_BUDGET_USD`). Actual billing amounts are set in the Partner Dashboard.
- `PLAN_OVERRIDE=solo|group` forces a plan in development.

### Cost note for the Group plan

Group messages are billed per recipient after the free tier. Assume a 5-person group with about 150 Storemate replies a month: that is 750 delivered messages. Meta's free tier is 1,000 per Storemate number **across all merchants**, so at scale most of these are billable. Check Meta's INR service rate for India before finalising $9.99. Keeping replies short and only answering when mentioned (already built in) is the main lever.

## 11.3 Switching LLMs (Claude, OpenAI, ...)

All model calls go through `app/agent/llm/`. Provider-neutral messages and tools are converted by one adapter per provider (`anthropic.ts`, `openai.ts`). Which model handles which job is configured with environment variables, so no code change is needed:

| Variable | Job | Default |
|---|---|---|
| `LLM_AGENT` | Main WhatsApp agent turns | `anthropic:claude-haiku-5-5` |
| `LLM_ESCALATION` | Hard tasks, refusals, "escalate_model" | `anthropic:claude-sonnet-5-5` |
| `LLM_LISTING` | Product copy from photos (vision + JSON) | `anthropic:claude-haiku-5-5` |
| `LLM_SUMMARY` | Checkout follow-up drafts | `anthropic:claude-haiku-5-5` |
| `LLM_FALLBACK` | Used once if the primary errors or refuses | unset |

Examples:

```bash
# Everything on OpenAI
LLM_AGENT=openai:gpt-5-mini LLM_ESCALATION=openai:gpt-5 LLM_LISTING=openai:gpt-5-mini LLM_SUMMARY=openai:gpt-5-mini
# Claude first, OpenAI as a safety net
LLM_FALLBACK=openai:gpt-5-mini
```

- Keys: `ANTHROPIC_API_KEY` (Claude Platform credits) and `OPENAI_API_KEY`.
- `OPENAI_REASONING_EFFORT=low` turns on reasoning effort for OpenAI reasoning models. Leave it unset for others.
- Costs are logged per call in `LlmUsage` using a price table (`app/agent/llm/index.ts`). Add or override prices with `LLM_PRICES_JSON` when you use a new model.
- Adding another provider (for example Gemini): implement `LlmProvider` (`complete(model, request)`), register it in `providerFor`, and use `"<provider>:<model>"` in the variables above.
- Claude-specific features (prompt caching, adaptive thinking, thinking blocks replayed unchanged) live only in the Claude adapter. OpenAI uses automatic prefix caching with `prompt_cache_key`.
