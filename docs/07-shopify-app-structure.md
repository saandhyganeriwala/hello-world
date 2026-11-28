# 7. Shopify App Structure

## 7.1 Repository layout

```
/
├─ apps/
│  ├─ shopify-app/                 # Shopify CLI React Router template (embedded admin + webhooks)
│  │  ├─ app/routes/
│  │  │  ├─ app._index.tsx         # dashboard: WhatsApp connection, budget, recent activity
│  │  │  ├─ app.connect.tsx        # wa.me link code + QR
│  │  │  ├─ app.approvals.tsx      # pending actions (approve from admin too)
│  │  │  ├─ app.activity.tsx       # audit log + undo
│  │  │  ├─ app.settings.tsx       # approval rules, language, summaries, optional scopes
│  │  │  ├─ app.simulator.tsx      # in-admin chat simulator (for reviewers and merchants without WhatsApp)
│  │  │  ├─ webhooks.app.uninstalled.tsx
│  │  │  ├─ webhooks.compliance.tsx  # customers/data_request, customers/redact, shop/redact
│  │  │  └─ webhooks.whatsapp.ts     # Meta webhook (GET verify + POST)
│  │  ├─ extensions/
│  │  │  └─ storefront-banner/      # Theme App Extension
│  │  │     ├─ blocks/banner.liquid
│  │  │     ├─ blocks/banner-embed.liquid
│  │  │     ├─ assets/banner.css
│  │  │     └─ shopify.extension.toml
│  │  └─ shopify.app.toml
│  └─ worker/                      # pg-boss consumers: inbound, agent, media, schedules
├─ packages/
│  ├─ agent/                       # loop, router, tiers, approvals (uses /agent prompt + tools)
│  ├─ shopify/                     # GraphQL client, throttle, typed operations (codegen)
│  ├─ whatsapp/                    # sender, media, templates
│  └─ db/                          # Prisma schema + migrations
├─ services/image/                 # Python FastAPI + rembg + pyvips
├─ agent/                          # system-prompt.md, tools.ts
└─ docs/
```

## 7.2 Install, auth and sessions

```mermaid
sequenceDiagram
  participant Mer as Merchant
  participant SA as Shopify Admin
  participant App as Our app (embedded)
  participant API as Shopify API
  Mer->>SA: Install from App Store
  SA->>SA: Managed installation (scopes from shopify.app.toml), merchant consents
  SA->>App: Load embedded app in iframe with id_token (session token JWT)
  App->>App: Verify JWT (HS256 with app secret, aud = client id, exp, dest = shop)
  App->>API: Token exchange: id_token -> offline access token (expiring, with refresh token)
  API-->>App: access_token, refresh_token, expires_in
  App->>App: Encrypt and store tokens; register shop; start onboarding
  Note over App: Background jobs (WhatsApp turns) use the stored offline token, refreshed before expiry
```

- **Managed installation and token exchange** are the default in the React Router template. There is no
  hand-built OAuth redirect.
- **Session tokens** authenticate every request from the embedded UI (App Bridge adds them). No cookies.
- **Offline tokens** are used by background workers, since WhatsApp traffic arrives with no admin session.
  Support **expiring offline tokens with refresh**, which Shopify is moving apps to, from day one.
- **Optional scopes** are requested from Settings, or from a WhatsApp deep link to `app.settings?grant=shipping`,
  with `shopify.scopes.request()`.
- **Uninstall**: revoke and delete tokens, disable WhatsApp bindings and close the shop's queue. `shop/redact`
  (48 h after uninstall) purges all shop data.

## 7.3 `shopify.app.toml` (excerpt)

```toml
client_id = "<from Partner Dashboard>"
name = "Storemate"
application_url = "https://app.storemate.example"
embedded = true

[access_scopes]
scopes = "read_products,write_products,read_publications,write_publications,read_inventory,write_inventory,read_locations,read_orders,read_themes"
optional_scopes = [
  "read_shipping", "write_shipping", "read_discounts", "write_discounts",
  "read_online_store_pages", "write_online_store_pages",
  "read_online_store_navigation", "write_online_store_navigation",
  "read_content", "write_content", "read_customers", "read_reports", "write_legal_policies"
]
use_legacy_install_flow = false

[auth]
redirect_urls = ["https://app.storemate.example/auth/callback"]

[webhooks]
api_version = "2026-10"   # pin the latest stable at build time

  [[webhooks.subscriptions]]
  topics = ["app/uninstalled", "app/scopes_update", "app_subscriptions/update"]
  uri = "/webhooks/app"

  [[webhooks.subscriptions]]
  compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
  uri = "/webhooks/compliance"

[pos]
embedded = false
```

## 7.4 Embedded app (what reviewers and merchants see)

The App Store expects a useful embedded experience, not just a link out. Screens, built with Polaris web components:

1. **Home**: WhatsApp connection status, this month's agent usage against the budget, last five actions, setup checklist
   (connect WhatsApp, enable the banner block, grant shipping scope).
2. **Connect WhatsApp**: QR code and wa.me link with a one-time code. List of linked numbers with roles. Revoke.
3. **Approvals**: pending actions with diffs. Approve or cancel here as well as on WhatsApp.
4. **Activity**: searchable audit log with Undo for reversible items.
5. **Settings**: language, approval rules, weekly summary day and time, quiet hours, optional scopes, data retention.
6. **Simulator**: a chat panel driving the same agent pipeline, so reviewers can test everything without a WhatsApp number.
7. **Plan**: Managed Pricing page link, usage add-ons.

Performance: meet Built for Shopify admin performance targets (fast LCP, no layout shift). Keep the bundle small and load data on the server.

## 7.5 Theme App Extension: banner (API-driven, no theme writes)

The agent writes a JSON app-data metafield on the AppInstallation. The app block renders it. The merchant adds
the block or enables the embed once, using a deep link the agent sends.

`extensions/storefront-banner/shopify.extension.toml`

```toml
api_version = "2026-10"
[[extensions]]
name = "Storemate banner"
handle = "storemate-banner"
type = "theme"
```

`extensions/storefront-banner/blocks/banner-embed.liquid` (app embed, shown on every page; no theme editing needed beyond turning it on)

```liquid
{%- assign cfg = app.metafields.banner.config.value -%}
{%- if cfg and cfg.enabled -%}
  {%- assign now = 'now' | date: '%s' | plus: 0 -%}
  {%- assign starts = cfg.starts_at | date: '%s' | plus: 0 -%}
  {%- assign ends = cfg.ends_at | default: '2999-01-01' | date: '%s' | plus: 0 -%}
  {%- if now >= starts and now < ends -%}
    <div class="sm-banner sm-banner--{{ cfg.style | default: 'neutral' | escape }}" role="region" aria-label="Announcement">
      {%- if cfg.link_url != blank -%}
        <a href="{{ cfg.link_url | escape }}">{{ cfg.text | escape }}</a>
      {%- else -%}
        {{ cfg.text | escape }}
      {%- endif -%}
    </div>
  {%- endif -%}
{%- endif -%}
{{ 'banner.css' | asset_url | stylesheet_tag }}

{% schema %}
{
  "name": "Storemate banner",
  "target": "body",
  "settings": []
}
{% endschema %}
```

Writing the banner (agent tool `set_store_banner`, tier C):

```graphql
mutation SetBanner($ownerId: ID!, $value: String!) {
  metafieldsSet(metafields: [{ ownerId: $ownerId, namespace: "banner", key: "config", type: "json", value: $value }]) {
    metafields { id updatedAt }
    userErrors { field message code }
  }
}
# ownerId = currentAppInstallation.id ; value = {"enabled":true,"text":"Free shipping above ₹999","style":"dark",...}
```

Deep links the agent sends when the embed or block is not active:

- App embed: `https://{shop}.myshopify.com/admin/themes/current/editor?context=apps&activateAppId={api_key}/banner-embed`
- App block on the home page: `https://{shop}.myshopify.com/admin/themes/current/editor?template=index&addAppBlockId={api_key}/banner&target=newAppsSection`

Check that the `starts_at`/`ends_at` comparison renders correctly when the block is built. Also consider scheduling
by updating the metafield from a job at the start and end times, which avoids depending on page caching.

The same pattern (app metafield or app-owned metaobject plus app block) extends to: trust badges, a size-guide
popup, a "new arrivals" strip, a WhatsApp chat button for shoppers, and festival sale countdowns. Together these
cover most "change my storefront" requests without touching theme code.

## 7.6 Billing

- **Managed Pricing** with one plan (₹499-equivalent, 7-day free trial) is the simplest option that complies.
  Shopify hosts the plan selection page and handles proration and trials.
- If usage add-ons are needed (extra Sonnet episodes, computer-use tasks), switch to the Billing API: a recurring
  line item plus a usage line item with `cappedAmount`, charged through `appUsageRecordCreate` with idempotency keys.
- Gate features on `app_subscriptions/update` webhook state plus a daily reconciliation job.
