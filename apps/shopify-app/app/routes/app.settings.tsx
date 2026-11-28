import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
} from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { ConnectWhatsApp } from "../components/ConnectWhatsApp";
import { config } from "../lib/config.server";
import { buildConnectInfo } from "../lib/connect.server";
import { maskPhone } from "../lib/phone";
import { activeMerchantUsers, ensureShop } from "../lib/shop.server";
import { consumeLinkCode } from "../lib/whatsapp.server";

const LANGUAGES = ["auto", "en", "hi"] as const;
const APPROVAL_MODES = ["standard", "strict"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin.graphql);
  const users = await activeMerchantUsers(shop.id);
  const url = new URL(request.url);
  const adding = url.searchParams.get("add") === "1" || users.length === 0;
  const storeHandle = session.shop.replace(/\.myshopify\.com$/, "");

  return {
    settings: {
      language: shop.settings.language,
      approvalMode: shop.settings.approvalMode,
      weeklySummaryEnabled: shop.settings.weeklySummaryEnabled,
      weeklySummaryDay: shop.settings.weeklySummaryDay,
      checkoutDigestEnabled: shop.settings.checkoutDigestEnabled,
    },
    users: users.map((u) => ({
      id: u.id,
      phone: maskPhone(u.waId),
      name: u.displayName,
      role: u.role,
      linkedAt: u.linkedAt.toISOString(),
    })),
    connect: adding ? await buildConnectInfo(shop.id) : null,
    planUrl: `https://admin.shopify.com/store/${storeHandle}/charges/${config.appHandle}/pricing_plans`,
    supportEmail: config.supportEmail,
    allowSimulate: !config.isProduction,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin.graphql);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "save") {
    const language = String(form.get("language"));
    const approvalMode = String(form.get("approvalMode"));
    const day = Number(form.get("weeklySummaryDay"));
    if (
      !LANGUAGES.includes(language as never) ||
      !APPROVAL_MODES.includes(approvalMode as never) ||
      !(day >= 1 && day <= 7)
    ) {
      return { ok: false, message: "Some settings were not valid" };
    }
    await db.shopSettings.update({
      where: { shopId: shop.id },
      data: {
        language,
        approvalMode,
        weeklySummaryDay: day,
        weeklySummaryEnabled: form.get("weeklySummaryEnabled") === "on",
        checkoutDigestEnabled: form.get("checkoutDigestEnabled") === "on",
      },
    });
    return { ok: true, message: "Settings saved" };
  }

  if (intent === "remove-number") {
    const id = String(form.get("id"));
    const user = await db.merchantUser.findFirst({
      where: { id, shopId: shop.id, revokedAt: null },
    });
    if (!user) return { ok: false, message: "Number not found" };
    await db.merchantUser.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    // Keep an owner: promote the oldest remaining number if the owner was removed.
    if (user.role === "owner") {
      const next = await db.merchantUser.findFirst({
        where: { shopId: shop.id, revokedAt: null },
        orderBy: { linkedAt: "asc" },
      });
      if (next)
        await db.merchantUser.update({
          where: { id: next.id },
          data: { role: "owner" },
        });
    }
    await db.auditEvent.create({
      data: {
        shopId: shop.id,
        actor: "merchant",
        tool: "unlink_whatsapp",
        summary: `Removed WhatsApp number ${maskPhone(user.waId)}`,
      },
    });
    return { ok: true, message: "Number removed" };
  }

  if (intent === "simulate-link") {
    if (config.isProduction) return { ok: false, message: "Not available" };
    const fakeId = `9198000${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`;
    const result = await consumeLinkCode(
      String(form.get("code")),
      fakeId,
      "Test staff",
    );
    return result.ok
      ? { ok: true, message: "Simulated connection" }
      : { ok: false, message: `Code ${result.reason}` };
  }

  return { ok: false, message: "Unknown action" };
};

const LANGUAGE_OPTIONS = [
  ["auto", "Same as my message"],
  ["en", "English"],
  ["hi", "Hindi"],
] as const;

// React 18 passes props to web components as attributes, and any attribute value (even "false")
// counts as on. These helpers add the attribute only when the condition holds.
const selectedIf = (on: boolean) => (on ? { selected: true } : {});
const checkedIf = (on: boolean) => (on ? { checked: true } : {});

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const shopify = useAppBridge();
  // Remount the form when stored settings change (after save) or on discard, so fields show stored values.
  const [discardCount, setDiscardCount] = useState(0);
  const formKey = `${JSON.stringify(data.settings)}-${discardCount}`;

  useEffect(() => {
    if (actionData?.message)
      shopify.toast.show(actionData.message, { isError: !actionData.ok });
  }, [actionData, shopify]);

  const saving =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "save";

  return (
    <s-page heading="Settings">
      {/* ---------------------------------------------------------------- WhatsApp numbers */}
      <s-section heading="WhatsApp numbers">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            These numbers can manage your store through Storemate. The owner
            approves deletions; anyone listed can approve other changes.
          </s-paragraph>
          {data.users.length > 0 && (
            <s-stack direction="block" gap="small-200">
              {data.users.map((user) => (
                <NumberRow key={user.id} user={user} />
              ))}
            </s-stack>
          )}
          {data.connect ? (
            <s-box border="base" borderRadius="base" padding="base">
              <ConnectWhatsApp
                connect={data.connect}
                linkedCount={data.users.length}
                allowSimulate={data.allowSimulate}
              />
            </s-box>
          ) : (
            <s-stack direction="inline">
              <s-button href="/app/settings?add=1" icon="plus">
                Add another number
              </s-button>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* ---------------------------------------------------------------- Preferences (contextual save bar) */}
      <Form
        method="post"
        key={formKey}
        data-save-bar
        data-discard-confirmation
        onReset={() => setDiscardCount((k) => k + 1)}
      >
        <input type="hidden" name="intent" value="save" />
        <s-stack direction="block" gap="base">
          <s-section heading="Assistant">
            <s-stack direction="block" gap="base">
              <s-select label="Reply language" name="language">
                {LANGUAGE_OPTIONS.map(([value, label]) => (
                  <s-option
                    key={value}
                    value={value}
                    {...selectedIf(data.settings.language === value)}
                  >
                    {label}
                  </s-option>
                ))}
              </s-select>

              <s-choice-list
                label="Ask for approval before"
                name="approvalMode"
              >
                <s-choice
                  value="standard"
                  {...selectedIf(data.settings.approvalMode === "standard")}
                >
                  Publishing, price, shipping, discount and storefront changes,
                  and deletions (recommended)
                </s-choice>
                <s-choice
                  value="strict"
                  {...selectedIf(data.settings.approvalMode === "strict")}
                >
                  All of the above, plus new drafts and stock changes
                </s-choice>
              </s-choice-list>
            </s-stack>
          </s-section>

          <s-section heading="WhatsApp updates">
            <s-stack direction="block" gap="base">
              <s-switch
                label="Weekly sales summary"
                name="weeklySummaryEnabled"
                {...checkedIf(data.settings.weeklySummaryEnabled)}
                details="Orders, revenue and top products for the past week."
              />
              <s-select label="Send on" name="weeklySummaryDay">
                {DAYS.map((day, i) => (
                  <s-option
                    key={day}
                    value={String(i + 1)}
                    {...selectedIf(data.settings.weeklySummaryDay === i + 1)}
                  >
                    {day}
                  </s-option>
                ))}
              </s-select>
              <s-switch
                label="Daily abandoned checkout digest"
                name="checkoutDigestEnabled"
                {...checkedIf(data.settings.checkoutDigestEnabled)}
                details="Only sent when there are abandoned checkouts."
              />
            </s-stack>
          </s-section>
        </s-stack>
        {saving && <s-text accessibilityVisibility="exclusive">Saving</s-text>}
      </Form>

      {/* ---------------------------------------------------------------- Aside */}
      <s-section slot="aside" heading="Plan">
        <s-stack direction="block" gap="small-200">
          <s-paragraph color="subdued">
            View or change your plan and billing.
          </s-paragraph>
          <s-stack direction="inline">
            <s-button href={data.planUrl} target="_top">
              Manage plan
            </s-button>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Help">
        <s-stack direction="block" gap="small-200">
          <s-paragraph color="subdued">
            Questions or something not working? We usually reply within a day.
          </s-paragraph>
          <s-link href={`mailto:${data.supportEmail}`}>
            {data.supportEmail}
          </s-link>
          <s-link href="/app">How to use Storemate</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function NumberRow({
  user,
}: {
  user: { id: string; phone: string; name: string | null; role: string };
}) {
  const fetcher = useFetcher<{ ok: boolean; message?: string }>();
  const shopify = useAppBridge();
  const modalId = `remove-number-${user.id}`;
  useEffect(() => {
    if (fetcher.data?.message)
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  return (
    <s-box border="base" borderRadius="base" padding="small-200">
      <s-stack
        direction="inline"
        justifyContent="space-between"
        alignItems="center"
      >
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-icon type="mobile" color="subdued" />
          <s-text>{user.phone}</s-text>
          {user.name && <s-text color="subdued">{user.name}</s-text>}
          <s-badge>{user.role === "owner" ? "Owner" : "Staff"}</s-badge>
        </s-stack>
        <s-button
          variant="tertiary"
          tone="critical"
          commandFor={modalId}
          command="--show"
          {...(fetcher.state !== "idle" ? { loading: true } : {})}
        >
          Remove
        </s-button>
      </s-stack>
      <s-modal id={modalId} heading={`Remove ${user.phone}?`}>
        <s-paragraph>
          This number will no longer be able to manage your store through
          Storemate. You can connect it again later.
        </s-paragraph>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor={modalId}
          command="--hide"
          onClick={() =>
            fetcher.submit(
              { intent: "remove-number", id: user.id },
              { method: "POST" },
            )
          }
        >
          Remove number
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor={modalId}
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
