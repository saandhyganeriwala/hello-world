# hello-world

Storemate (working name): a WhatsApp AI agent that runs a merchant's Shopify store, built as a public
Shopify app. It uses the Shopify GraphQL Admin API first, a Theme App Extension for storefront changes,
the direct Meta WhatsApp Cloud API, and Claude (Haiku 5.5 by default, Sonnet 5.5 on escalation).

- Design pack: [docs/README.md](docs/README.md)
- Agent (prompt, tools, loop, model providers): [apps/shopify-app/app/agent](apps/shopify-app/app/agent)
- Groups, plans and switching LLMs: [docs/11-groups-plans-and-llms.md](docs/11-groups-plans-and-llms.md)
- Shopify app (embedded admin, webhooks, theme extension): [apps/shopify-app](apps/shopify-app/README.md)
- Screens: [docs/screenshots](docs/screenshots)
