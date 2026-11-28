# Agent

The agent now lives in the Shopify app, next to the code that runs it:

- System prompt: `apps/shopify-app/app/agent/prompt.ts`
- Tool definitions (tiers, plan gating): `apps/shopify-app/app/agent/tools/definitions.ts`
- Tool handlers: `apps/shopify-app/app/agent/tools/handlers.server.ts`
- Agent loop: `apps/shopify-app/app/agent/loop.server.ts`
- Model providers (Claude, OpenAI) and routing: `apps/shopify-app/app/agent/llm/`

See `docs/11-groups-plans-and-llms.md` for how to switch models.
