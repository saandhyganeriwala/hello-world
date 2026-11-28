import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { ConnectWhatsApp } from "../components/ConnectWhatsApp";
import { TeamGroup } from "../components/TeamGroup";
import { config } from "../lib/config.server";
import { buildConnectInfo } from "../lib/connect.server";
import {
  buildGroupInfo,
  deleteStoreGroup,
  removeStoreGroupParticipant,
  resetStoreGroupInvite,
} from "../lib/groups.server";
import { maskPhone } from "../lib/phone";
import { hasFeature, maxDirectNumbers, planInfo } from "../lib/plans";
import { currentPlan } from "../lib/plans.server";
import { activeMerchantUsers, ensureShop } from "../lib/shop.server";
import { consumeLinkCode } from "../lib/whatsapp.server";

const LANGUAGES = ["auto", "en", "hi"] as const;
const APPROVAL_MODES = ["standard", "strict"] as const;
const FREQUENCIES = ["off", "daily", "weekly"] as const;
const DESTINATIONS = ["group", "dm"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin.graphql);
  const plan = await currentPlan(shop, admin.graphql);
  const users = await activeMerchantUsers(shop.id);
  const limit = maxDirectNumbers(plan);
  const url = new URL(request.url);
  const adding =
    (url.searchParams.get("add") === "1" || users.length === 0) &&
    users.length < limit;
  const storeHandle = session.shop.replace(/\.myshopify\.com$/, "");
  const s = shop.settings;

  return {
    plan,
    planName: planInfo(plan)?.name ?? "No plan",
    features: {
      group: hasFeature(plan, "group"),
      summaries: hasFeature(plan, "summaries"),
      checkoutRecovery: hasFeature(plan, "checkoutRecovery"),
    },
    numberLimit: limit,
    settings: {
      language: s.language,
      approvalMode: s.approvalMode,
      summaryFrequency: s.summaryFrequency,
      weeklySummaryDay: s.weeklySummaryDay,
      summaryHour: s.summaryHour,
      checkoutDigestEnabled: s.checkoutDigestEnabled,
      updatesDestination: s.updatesDestination,
    },
    users: users.map((u) => ({
      id: u.id,
      phone: maskPhone(u.waId),
      name: u.displayName,
      role: u.role,
      linkedAt: u.linkedAt.toISOString(),
    })),
    connect: adding ? await buildConnectInfo(shop.id) : null,
    group: hasFeature(plan, "group") ? await buildGroupInfo(shop.id) : null,
    planUrl: `https://admin.shopify.com/store/${storeHandle}/charges/${config.appHandle}/pricing_plans`,
    supportEmail: config.supportEmail,
    allowSimulate: !config.isProduction,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin.graphql);
  const plan = await currentPlan(shop, admin.graphql);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const str = (key: string) => String(form.get(key) ?? "");

  switch (intent) {
    case "save": {
      const language = str("language");
      const approvalMode = str("approvalMode");
      if (
        !LANGUAGES.includes(language as never) ||
        !APPROVAL_MODES.includes(approvalMode as never)
      ) {
        return { ok: false, message: "Some settings were not valid" };
      }
      const data: Record<string, unknown> = { language, approvalMode };
      if (hasFeature(plan, "summaries")) {
        const frequency = str("summaryFrequency");
        const day = Number(str("weeklySummaryDay"));
        const hour = Number(str("summaryHour"));
        const destination = str("updatesDestination") || "dm";
        if (
          !FREQUENCIES.includes(frequency as never) ||
          !(day >= 1 && day <= 7) ||
          !(hour >= 0 && hour <= 23) ||
          !DESTINATIONS.includes(destination as never)
        ) {
          return { ok: false, message: "Some settings were not valid" };
        }
        Object.assign(data, {
          summaryFrequency: frequency,
          weeklySummaryDay: day,
          summaryHour: hour,
          updatesDestination: destination,
        });
      }
      if (hasFeature(plan, "checkoutRecovery"))
        data.checkoutDigestEnabled = form.get("checkoutDigestEnabled") === "on";
      await db.shopSettings.update({ where: { shopId: shop.id }, data });
      return { ok: true, message: "Settings saved" };
    }

    case "remove-number": {
      const user = await db.merchantUser.findFirst({
        where: { id: str("id"), shopId: shop.id, revokedAt: null },
      });
      if (!user) return { ok: false, message: "Number not found" };
      await db.merchantUser.update({
        where: { id: user.id },
        data: { revokedAt: new Date() },
      });
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

    case "reset-invite":
      return (await resetStoreGroupInvite(shop.id))
        ? { ok: true, message: "New invite link created" }
        : { ok: false, message: "No group yet" };

    case "remove-participant":
      return (await removeStoreGroupParticipant(shop.id, str("id")))
        ? { ok: true, message: "Removed from the group" }
        : { ok: false, message: "Couldn't remove" };

    case "delete-group":
      await deleteStoreGroup(shop.id);
      await db.auditEvent.create({
        data: {
          shopId: shop.id,
          actor: "merchant",
          tool: "delete_group",
          summary: "Deleted the team group",
        },
      });
      return { ok: true, message: "Group deleted" };

    case "create-group": {
      if (!hasFeature(plan, "group"))
        return {
          ok: false,
          message: "The team group is part of the Group plan",
        };
      const { createStoreGroup } = await import("../lib/groups.server");
      const group = await createStoreGroup(shop);
      return group.status === "failed"
        ? { ok: false, message: "Couldn't create the group" }
        : { ok: true, message: "Creating your team group" };
    }

    case "simulate-link": {
      if (config.isProduction) return { ok: false, message: "Not available" };
      const fakeId = `9198000${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`;
      const result = await consumeLinkCode(str("code"), fakeId, "Test staff");
      return result.ok
        ? { ok: true, message: "Simulated connection" }
        : { ok: false, message: `Code ${result.reason}` };
    }
  }
  return { ok: false, message: "Unknown action" };
};

const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const LANGUAGE_OPTIONS = [
  ["auto", "Same as my message"],
  ["en", "English"],
  ["hi", "Hindi"],
] as const;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

// React 18 passes props to web components as attributes, and any attribute value (even "false")
// counts as on. These helpers add the attribute only when the condition holds.
const selectedIf = (on: boolean) => (on ? { selected: true } : {});
const checkedIf = (on: boolean) => (on ? { checked: true } : {});
const disabledIf = (on: boolean) => (on ? { disabled: true } : {});

function hourLabel(h: number) {
  const suffix = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:00 ${suffix}`;
}

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const shopify = useAppBridge();
  const [discardCount, setDiscardCount] = useState(0);
  const formKey = `${JSON.stringify(data.settings)}-${data.plan}-${discardCount}`;

  useEffect(() => {
    if (actionData?.message)
      shopify.toast.show(actionData.message, { isError: !actionData.ok });
  }, [actionData, shopify]);

  const atLimit = data.users.length >= data.numberLimit;
  const groupOnly = "Available on the Group plan.";

  return (
    <s-page heading="Settings">
      {/* ---------------------------------------------------------------- Numbers */}
      <s-section heading="WhatsApp numbers">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            {data.numberLimit === 1
              ? "Your plan includes one WhatsApp number that can chat with Storemate."
              : `Up to ${data.numberLimit} numbers can chat with Storemate one-to-one. The owner approves deletions; anyone listed can approve other changes.`}
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
          ) : atLimit ? (
            data.numberLimit === 1 && (
              <s-text color="subdued">
                Need your team on Storemate? The Group plan adds a team group
                and more numbers. <s-link href="/app/plan">See plans</s-link>
              </s-text>
            )
          ) : (
            <s-stack direction="inline">
              <s-button href="/app/settings?add=1" icon="plus">
                Add another number
              </s-button>
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* ---------------------------------------------------------------- Team group */}
      <s-section heading="Team group">
        {data.features.group ? (
          <TeamGroup
            group={data.group}
            manage
            disabledReason={
              data.users.length ? null : "Connect your WhatsApp first."
            }
          />
        ) : (
          <s-paragraph color="subdued">
            A shared WhatsApp group where your team (up to 8 people) works with
            Storemate together. {groupOnly}{" "}
            <s-link href="/app/plan">See plans</s-link>
          </s-paragraph>
        )}
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
                  All of the above, plus stock changes and product edits
                </s-choice>
              </s-choice-list>
            </s-stack>
          </s-section>

          <s-section heading="Sales summaries">
            <s-stack direction="block" gap="base">
              {!data.features.summaries && (
                <s-text color="subdued">
                  {groupOnly} <s-link href="/app/plan">See plans</s-link>
                </s-text>
              )}
              <s-select
                label="Send a summary"
                name="summaryFrequency"
                {...disabledIf(!data.features.summaries)}
              >
                <s-option
                  value="off"
                  {...selectedIf(data.settings.summaryFrequency === "off")}
                >
                  Never
                </s-option>
                <s-option
                  value="daily"
                  {...selectedIf(data.settings.summaryFrequency === "daily")}
                >
                  Every day (yesterday’s sales)
                </s-option>
                <s-option
                  value="weekly"
                  {...selectedIf(data.settings.summaryFrequency === "weekly")}
                >
                  Every week (last 7 days)
                </s-option>
              </s-select>
              <s-query-container>
                <s-grid
                  gridTemplateColumns="@container (inline-size > 480px) 1fr 1fr, 1fr"
                  gap="base"
                >
                  <s-select
                    label="Day (weekly)"
                    name="weeklySummaryDay"
                    {...disabledIf(!data.features.summaries)}
                  >
                    {DAYS.map((day, i) => (
                      <s-option
                        key={day}
                        value={String(i + 1)}
                        {...selectedIf(
                          data.settings.weeklySummaryDay === i + 1,
                        )}
                      >
                        {day}
                      </s-option>
                    ))}
                  </s-select>
                  <s-select
                    label="Time"
                    name="summaryHour"
                    {...disabledIf(!data.features.summaries)}
                  >
                    {HOURS.map((h) => (
                      <s-option
                        key={h}
                        value={String(h)}
                        {...selectedIf(data.settings.summaryHour === h)}
                      >
                        {hourLabel(h)}
                      </s-option>
                    ))}
                  </s-select>
                </s-grid>
              </s-query-container>
              <s-select
                label="Send updates to"
                name="updatesDestination"
                {...disabledIf(!data.features.summaries)}
              >
                <s-option
                  value="group"
                  {...selectedIf(data.settings.updatesDestination === "group")}
                >
                  Team group (owner’s chat if there’s no group)
                </s-option>
                <s-option
                  value="dm"
                  {...selectedIf(data.settings.updatesDestination === "dm")}
                >
                  Owner’s WhatsApp chat
                </s-option>
              </s-select>
            </s-stack>
          </s-section>

          <s-section heading="Abandoned checkouts">
            <s-stack direction="block" gap="base">
              {!data.features.checkoutRecovery && (
                <s-text color="subdued">
                  {groupOnly} <s-link href="/app/plan">See plans</s-link>
                </s-text>
              )}
              <s-switch
                label="Daily abandoned checkout digest"
                name="checkoutDigestEnabled"
                details="A short daily note when shoppers leave items in checkout. Ask Storemate to draft follow-ups you send from your own WhatsApp."
                {...checkedIf(
                  data.features.checkoutRecovery &&
                    data.settings.checkoutDigestEnabled,
                )}
                {...disabledIf(!data.features.checkoutRecovery)}
              />
            </s-stack>
          </s-section>
        </s-stack>
      </Form>

      {/* ---------------------------------------------------------------- Aside */}
      <s-section slot="aside" heading="Plan">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            Current plan: <s-text type="strong">{data.planName}</s-text>
          </s-paragraph>
          <s-stack direction="inline" gap="small-200">
            <s-button href="/app/plan">Compare plans</s-button>
            <s-button variant="tertiary" href={data.planUrl} target="_top">
              Billing
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

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
