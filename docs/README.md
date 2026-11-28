# WhatsApp Store Agent for Shopify: Design Pack (v0.1)

A public Shopify app. Merchants manage their store by chatting with an agent on WhatsApp.
Target price: ₹499/month or less. Cost and reliability come before raw model intelligence.

## Contents

| # | Document | Deliverable |
|---|----------|-------------|
| 1 | [01-architecture.md](01-architecture.md) | System architecture, diagrams, data model |
| 2 | [02-tech-stack.md](02-tech-stack.md) | Recommended stack and why |
| 3 | [03-shopify-api-surface.md](03-shopify-api-surface.md) | GraphQL queries/mutations, scopes, rate limits |
| 4 | [04-whatsapp-cloud-api.md](04-whatsapp-cloud-api.md) | WhatsApp Cloud API integration |
| 5 | [05-agent-design.md](05-agent-design.md); code in `apps/shopify-app/app/agent/` | Agent loop, model routing, system prompt, tool definitions |
| 6 | [06-computer-use-fallback.md](06-computer-use-fallback.md) | Fallback ladder and computer-use design |
| 7 | [07-shopify-app-structure.md](07-shopify-app-structure.md) | OAuth, embedded app, Theme App Extension examples |
| 8 | [08-cost-model.md](08-cost-model.md) | Unit economics at ₹499/month |
| 9 | [09-implementation-plan.md](09-implementation-plan.md) | Milestones and the first sprint |
| 10 | [10-risks.md](10-risks.md) | Risks, App Store review concerns, mitigations |
| 11 | [11-groups-plans-and-llms.md](11-groups-plans-and-llms.md) | WhatsApp Groups API facts, Solo/Group plans, switching LLMs |

## How we read the brief

1. **API first.** Every action goes through the Shopify GraphQL Admin API when the API supports it.
   Storefront changes go through a Theme App Extension (app blocks and app embeds) that reads
   app-owned data. The app never edits theme code.
2. **A ladder of fallbacks, with computer use at the bottom.** In order:
   (a) typed API tools, (b) schema-validated generic GraphQL, (c) guided fallback
   (deep link plus step-by-step instructions the merchant follows), (d) computer use.
   Rung (d) is off by default and is not part of the App Store build at launch (see doc 06 and doc 10).
3. **App Store compliance is a hard constraint.** That means Shopify managed install with
   token exchange, session tokens, Shopify Billing, mandatory compliance webhooks, protected
   customer data approval, no merchant passwords, and no theme code edits.
4. **Direct Meta WhatsApp Cloud API**, with no BSP in between.
5. **Cost controls are built in, not added later.** Claude Haiku 5.5 handles routing and most
   turns. Claude Sonnet 5.5 is used only on explicit escalation. Every call is metered per
   merchant against a monthly budget. Approvals run the frozen mutation directly, with no extra
   LLM call.

## Decisions taken without asking (say if you disagree)

| Decision | Choice | Why |
|---|---|---|
| Language | TypeScript (Node 22) for the app, agent and workers. Python only for the image service. | Shopify's official app template is TypeScript. The image libraries are best in Python. |
| Agent hosting | We host the loop on the Claude Messages API. We do not use Managed Agents. | Managed Agents bills session runtime and runs a container per session. Neither fits a ₹499 margin. We also need approvals that span WhatsApp turns. |
| WhatsApp numbers | One platform number for all merchant↔agent chat (v1). Messages to customers come from the merchant's own WhatsApp: v1 by tap-to-send `wa.me` drafts, v2 by Embedded Signup with the app as a Meta Tech Provider. | No BSP. Zero customer-messaging cost to us. Meta's opt-in rules stay with the merchant's own number. |
| Installing other apps | Guided only: the agent sends the App Store link and the merchant approves it. | No API exists. OAuth consent must come from the merchant, and automating it is a review and trust risk. |
| Computer use | Designed and behind a feature flag. Off in the App Store build. | Likely conflicts with Shopify's terms and review. See doc 06. |
| Hosting | Railway (Singapore region), Postgres, pg-boss queue, Cloudflare R2 for temporary images. | Low ops, usage-based pricing, near Indian merchants. Railway is already connected to this workspace. |

## Open questions (none block the design)

1. Is the computer-use posture in doc 06 acceptable? It is off for App Store merchants, with a possible later
   opt-in in the merchant's own browser.
2. Should customer-facing WhatsApp sending from the merchant's own number be v1 or v2? (Recommendation: v2.)
3. Languages: should merchant chat support Hindi and Hinglish at launch? (Assumed yes. The agent replies in the merchant's language.)
