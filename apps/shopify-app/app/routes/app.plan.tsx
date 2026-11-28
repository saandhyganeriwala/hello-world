import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { config } from "../lib/config.server";
import { PLANS } from "../lib/plans";
import { currentPlan } from "../lib/plans.server";
import { ensureShop } from "../lib/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin.graphql);
  const plan = await currentPlan(shop, admin.graphql);
  const storeHandle = session.shop.replace(/\.myshopify\.com$/, "");
  return {
    plan,
    plans: Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      price: p.priceUsd,
      tagline: p.tagline,
      features: p.features,
    })),
    planUrl: `https://admin.shopify.com/store/${storeHandle}/charges/${config.appHandle}/pricing_plans`,
  };
};

export default function Plan() {
  const { plan, plans, planUrl } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Plan">
      {plan === "none" && (
        <s-banner tone="info" heading="Choose a plan to start">
          <s-paragraph>
            Storemate starts answering on WhatsApp once a plan is active. Both
            plans include a free trial.
          </s-paragraph>
        </s-banner>
      )}

      <s-section>
        <s-query-container>
          <s-grid
            gridTemplateColumns="@container (inline-size > 560px) 1fr 1fr, 1fr"
            gap="base"
          >
            {plans.map((p) => {
              const current = p.id === plan;
              return (
                <s-box
                  key={p.id}
                  border="base"
                  borderRadius="base"
                  padding="base"
                >
                  <s-stack direction="block" gap="base">
                    <s-stack
                      direction="inline"
                      justifyContent="space-between"
                      alignItems="center"
                    >
                      <s-heading>{p.name}</s-heading>
                      {current && (
                        <s-badge tone="success">Current plan</s-badge>
                      )}
                    </s-stack>
                    <s-stack
                      direction="inline"
                      gap="small-300"
                      alignItems="baseline"
                    >
                      <s-text type="strong">${p.price.toFixed(2)}</s-text>
                      <s-text color="subdued">per month</s-text>
                    </s-stack>
                    <s-paragraph color="subdued">{p.tagline}</s-paragraph>
                    <s-unordered-list>
                      {p.features.map((f) => (
                        <s-list-item key={f}>{f}</s-list-item>
                      ))}
                    </s-unordered-list>
                    <s-stack direction="inline">
                      <s-button
                        href={planUrl}
                        target="_top"
                        variant={current ? "secondary" : "primary"}
                      >
                        {current
                          ? "Manage plan"
                          : plan === "none"
                            ? `Choose ${p.name}`
                            : `Switch to ${p.name}`}
                      </s-button>
                    </s-stack>
                  </s-stack>
                </s-box>
              );
            })}
          </s-grid>
        </s-query-container>
      </s-section>

      <s-section heading="Good to know">
        <s-unordered-list>
          <s-list-item>
            Plans are billed by Shopify with your store bill. Change or cancel
            any time.
          </s-list-item>
          <s-list-item>
            The team group lets up to 8 people talk to Storemate together.
            People join with an invite link; WhatsApp doesn’t let businesses add
            members directly.
          </s-list-item>
          <s-list-item>
            Each plan includes a monthly assistant allowance; you’ll see your
            usage on the Home page.
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
