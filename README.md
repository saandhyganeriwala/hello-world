# hello-world

Storemate (working name): a WhatsApp AI agent that runs a merchant's Shopify store, built as a public
Shopify app. It uses the Shopify GraphQL Admin API first, a Theme App Extension for storefront changes,
the direct Meta WhatsApp Cloud API, and Claude (Haiku 5.5 by default, Sonnet 5.5 on escalation).

- Design pack: [docs/README.md](docs/README.md)
- Agent system prompt: [agent/system-prompt.md](agent/system-prompt.md)
- Agent tool definitions: [agent/tools.ts](agent/tools.ts)
- Shopify app (embedded admin, webhooks, theme extension): [apps/shopify-app](apps/shopify-app/README.md)
- Screens: [docs/screenshots](docs/screenshots)
