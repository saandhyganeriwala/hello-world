import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { ConnectWhatsApp } from "../components/ConnectWhatsApp";
import { config } from "../lib/config.server";
import { buildConnectInfo } from "../lib/connect.server";
import { maskPhone } from "../lib/phone";
import {
  activeMerchantUsers,
  ensureShop,
  monthlyStats,
} from "../lib/shop.server";
import { activateEmbedUrl } from "../lib/theme-embed";
import { storefrontEmbedEnabled } from "../lib/theme.server";
import {
  connectLinks,
  connectedWelcome,
  consumeLinkCode,
  sendText,
} from "../lib/whatsapp.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin.graphql);
  const users = await activeMerchantUsers(shop.id);
  const connected = users.length > 0;

  const [embedEnabled, stats, recent, pendingCount, connect] =
    await Promise.all([
      storefrontEmbedEnabled(admin.graphql),
      monthlyStats(shop.id, config.monthlyLlmBudgetUsd),
      db.auditEvent.findMany({
        where: { shopId: shop.id },
        orderBy: { createdAt: "desc" },
        take: 5,
      }),
      db.pendingAction.count({
        where: {
          shopId: shop.id,
          status: "pending",
          expiresAt: { gt: new Date() },
        },
      }),
      connected ? Promise.resolve(null) : buildConnectInfo(shop.id),
    ]);

  const owner = users.find((u) => u.role === "owner") ?? users[0];
  return {
    shopName: shop.name ?? session.shop,
    connected,
    linkedCount: users.length,
    ownerPhone: owner ? maskPhone(owner.waId) : null,
    chatUrl: connectLinks("").chatUrl,
    connect,
    embedEnabled,
    embedUrl: activateEmbedUrl(session.shop, config.shopifyApiKey),
    storefrontSkipped: Boolean(shop.storefrontStepSkippedAt),
    setupDismissed: Boolean(shop.setupDismissedAt),
    stats,
    pendingCount,
    recent: recent.map((e) => ({
      id: e.id,
      summary: e.summary,
      status: e.status,
      createdAt: e.createdAt.toISOString(),
    })),
    allowSimulate: !config.isProduction,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin.graphql);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  switch (intent) {
    case "dismiss-setup":
      await db.shop.update({
        where: { id: shop.id },
        data: { setupDismissedAt: new Date() },
      });
      return { ok: true, message: "Setup guide hidden" };
    case "show-setup":
      await db.shop.update({
        where: { id: shop.id },
        data: { setupDismissedAt: null },
      });
      return { ok: true };
    case "skip-storefront":
      await db.shop.update({
        where: { id: shop.id },
        data: { storefrontStepSkippedAt: new Date() },
      });
      return { ok: true, message: "Skipped. You can turn it on any time." };
    case "send-test": {
      const owner = (await activeMerchantUsers(shop.id))[0];
      if (!owner) return { ok: false, message: "Connect WhatsApp first" };
      const result = await sendText(
        owner.waId,
        `Test message from Storemate for ${shop.name ?? session.shop}. You're all set.`,
        shop.id,
      );
      return {
        ok: true,
        message: result.mocked
          ? "Test message logged (WhatsApp not configured)"
          : "Test message sent",
      };
    }
    case "simulate-link": {
      if (config.isProduction) return { ok: false, message: "Not available" };
      const result = await consumeLinkCode(
        String(form.get("code")),
        "919800000210",
        "Test merchant",
      );
      if (result.ok)
        await sendText(
          "919800000210",
          connectedWelcome(result.shopName),
          shop.id,
        );
      return result.ok
        ? { ok: true, message: "Simulated connection" }
        : { ok: false, message: `Code ${result.reason}` };
    }
    default:
      return { ok: false, message: "Unknown action" };
  }
};

const EXAMPLES = [
  {
    title: "Add a product",
    icon: "product-add",
    text: "Send 2–6 photos, then: Cotton kurta, ₹799, sizes S M L, 10 each",
    note: "I clean up the photos, write the title, description and tags, and create a draft for you to publish.",
  },
  {
    title: "Change prices",
    icon: "cash-rupee",
    text: "Increase all saree prices by 10%",
    note: "You see every old and new price before anything changes.",
  },
  {
    title: "Shipping",
    icon: "delivery",
    text: "Free shipping above ₹999",
    note: "I show the new rates and wait for your approval.",
  },
  {
    title: "Store banner",
    icon: "megaphone",
    text: "Add a banner: Diwali sale, 20% off till Sunday",
    note: "Needs the storefront step turned on.",
  },
  {
    title: "Sales summary",
    icon: "chart-vertical",
    text: "How were sales this week?",
    note: "You also get a short summary every Monday.",
  },
  {
    title: "Abandoned carts",
    icon: "cart-abandoned",
    text: "Show abandoned checkouts from yesterday",
    note: "I draft friendly follow-ups you can send from your own WhatsApp.",
  },
] as const;

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Home() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();
  const fetcher = useFetcher<{ ok: boolean; message?: string }>();
  const revalidator = useRevalidator();

  const storefrontDone = data.embedEnabled === true || data.storefrontSkipped;
  const completed = (data.connected ? 1 : 0) + (storefrontDone ? 1 : 0);
  const allDone = completed === 2;

  // The first unfinished step is open by default; a manual toggle sticks until a step's status changes.
  const stepKey = `${data.connected}-${storefrontDone}`;
  const defaultOpen: 1 | 2 | null = !data.connected
    ? 1
    : !storefrontDone
      ? 2
      : null;
  const [toggle, setToggle] = useState<{
    key: string;
    open: 1 | 2 | null;
  } | null>(null);
  const open = toggle && toggle.key === stepKey ? toggle.open : defaultOpen;
  const setOpen = (value: 1 | 2 | null) =>
    setToggle({ key: stepKey, open: value });

  useEffect(() => {
    if (fetcher.data?.message)
      shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  // When the merchant comes back from the theme editor tab, re-check the embed.
  useEffect(() => {
    if (data.embedEnabled) return;
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        revalidator.state === "idle"
      )
        revalidator.revalidate();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [data.embedEnabled, revalidator]);

  const submit = (intent: string) =>
    fetcher.submit({ intent }, { method: "POST" });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      shopify.toast.show("Copied");
    } catch {
      shopify.toast.show("Couldn't copy. Select the text instead.", {
        isError: true,
      });
    }
  };

  return (
    <s-page heading="Home">
      {data.pendingCount > 0 && (
        <s-banner
          tone="info"
          heading={`${data.pendingCount} ${data.pendingCount === 1 ? "change is" : "changes are"} waiting for your approval`}
        >
          <s-paragraph>Approve them in WhatsApp or here.</s-paragraph>
          <s-button slot="secondary-actions" href="/app/activity">
            Review
          </s-button>
        </s-banner>
      )}

      {/* ---------------------------------------------------------------- Setup guide */}
      {!(allDone && data.setupDismissed) && (
        <s-section>
          <s-stack direction="block" gap="base">
            <s-stack
              direction="inline"
              justifyContent="space-between"
              alignItems="center"
            >
              <s-stack direction="block" gap="small-300">
                <s-heading>
                  {allDone ? "You're all set" : "Set up Storemate"}
                </s-heading>
                <s-text color="subdued">
                  {allDone
                    ? "Manage your store by messaging Storemate on WhatsApp."
                    : "Two quick steps, then you can run your store from WhatsApp."}
                </s-text>
              </s-stack>
              {allDone && (
                <s-button
                  variant="tertiary"
                  icon="x"
                  accessibilityLabel="Hide setup guide"
                  onClick={() => submit("dismiss-setup")}
                />
              )}
            </s-stack>

            <s-text color="subdued">{completed} of 2 steps complete</s-text>
            <ProgressBar value={completed} max={2} />

            <s-stack direction="block" gap="none">
              <SetupStep
                index={1}
                title="Connect your WhatsApp"
                done={data.connected}
                open={open === 1}
                onToggle={() => setOpen(open === 1 ? null : 1)}
              >
                {data.connected ? (
                  <s-stack direction="block" gap="base">
                    <s-paragraph>
                      Connected to{" "}
                      <s-text type="strong">{data.ownerPhone}</s-text>. Save the
                      Storemate number in your contacts so it’s easy to find.
                    </s-paragraph>
                    <s-stack direction="inline" gap="small-200">
                      {data.chatUrl && (
                        <s-button
                          href={data.chatUrl}
                          target="_blank"
                          icon="chat"
                        >
                          Open chat
                        </s-button>
                      )}
                      <s-button
                        variant="tertiary"
                        onClick={() => submit("send-test")}
                        {...(fetcher.state !== "idle" ? { loading: true } : {})}
                      >
                        Send a test message
                      </s-button>
                    </s-stack>
                  </s-stack>
                ) : (
                  data.connect && (
                    <ConnectWhatsApp
                      connect={data.connect}
                      linkedCount={data.linkedCount}
                      allowSimulate={data.allowSimulate}
                    />
                  )
                )}
              </SetupStep>

              <s-divider />

              <SetupStep
                index={2}
                title="Show banners on your store"
                optional
                done={storefrontDone}
                doneLabel={data.embedEnabled ? undefined : "Skipped"}
                open={open === 2}
                onToggle={() => setOpen(open === 2 ? null : 2)}
              >
                <s-stack direction="block" gap="base">
                  <s-paragraph>
                    Lets Storemate show announcement banners, like “Free
                    shipping above ₹999”, when you ask for one. It doesn’t
                    change your theme’s design. In the theme editor, check that
                    Storemate banner is on, then click Save.
                  </s-paragraph>
                  {data.embedEnabled ? (
                    <s-text>Turned on in your live theme.</s-text>
                  ) : (
                    <s-stack direction="inline" gap="small-200">
                      <s-button
                        variant="primary"
                        href={data.embedUrl}
                        target="_blank"
                        icon="theme-edit"
                      >
                        Open theme editor
                      </s-button>
                      <s-button
                        onClick={() => revalidator.revalidate()}
                        {...(revalidator.state !== "idle"
                          ? { loading: true }
                          : {})}
                      >
                        Check again
                      </s-button>
                      {!data.storefrontSkipped && (
                        <s-button
                          variant="tertiary"
                          onClick={() => submit("skip-storefront")}
                        >
                          Skip for now
                        </s-button>
                      )}
                    </s-stack>
                  )}
                  {data.embedEnabled === null && (
                    <s-text color="subdued">
                      We couldn’t read your theme just now. Use Check again
                      after saving in the theme editor.
                    </s-text>
                  )}
                </s-stack>
              </SetupStep>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      {/* ---------------------------------------------------------------- How to use */}
      <s-section heading="Things you can ask">
        <s-stack direction="block" gap="base">
          <s-paragraph color="subdued">
            Message Storemate the way you’d message a helper, in English, Hindi
            or Hinglish.
          </s-paragraph>
          <s-query-container>
            <s-grid
              gridTemplateColumns="@container (inline-size > 520px) 1fr 1fr, 1fr"
              gap="base"
            >
              {EXAMPLES.map((example) => (
                <s-box
                  key={example.title}
                  border="base"
                  borderRadius="base"
                  padding="base"
                >
                  <s-stack direction="block" gap="small-200">
                    <s-stack
                      direction="inline"
                      gap="small-200"
                      alignItems="center"
                    >
                      <s-icon type={example.icon} color="subdued" />
                      <s-text type="strong">{example.title}</s-text>
                    </s-stack>
                    <s-box
                      background="subdued"
                      borderRadius="base"
                      padding="small-200"
                    >
                      <s-grid
                        gridTemplateColumns="1fr auto"
                        alignItems="center"
                        gap="small-200"
                      >
                        <s-text>“{example.text}”</s-text>
                        <s-button
                          variant="tertiary"
                          icon="clipboard"
                          accessibilityLabel={`Copy example: ${example.text}`}
                          onClick={() => copy(example.text)}
                        />
                      </s-grid>
                    </s-box>
                    <s-text color="subdued">{example.note}</s-text>
                  </s-stack>
                </s-box>
              ))}
            </s-grid>
          </s-query-container>
        </s-stack>
      </s-section>

      <s-section heading="You stay in control">
        <s-unordered-list>
          <s-list-item>
            Storemate asks before it publishes products or changes prices,
            shipping, discounts or your storefront. Tap Approve or Cancel in
            WhatsApp.
          </s-list-item>
          <s-list-item>
            Reply UNDO to reverse the last change. Everything is listed under
            Activity.
          </s-list-item>
          <s-list-item>
            For the sharpest product photos, send them as a document instead of
            a photo.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      {/* ---------------------------------------------------------------- Aside */}
      <s-section slot="aside" heading="This month">
        <s-stack direction="block" gap="small-200">
          <Stat label="Messages handled" value={data.stats.messages} />
          <Stat label="Products created" value={data.stats.products} />
          <Stat label="Changes made" value={data.stats.changes} />
          <Stat
            label="Assistant usage"
            value={`${data.stats.budgetUsedPercent}%`}
          />
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Recent activity">
        {data.recent.length === 0 ? (
          <s-text color="subdued">
            Nothing yet. Changes Storemate makes will show up here.
          </s-text>
        ) : (
          <s-stack direction="block" gap="small-200">
            {data.recent.map((event) => (
              <s-stack key={event.id} direction="block" gap="small-500">
                <s-text>{event.summary}</s-text>
                <s-text color="subdued">
                  {formatDate(event.createdAt)}
                  {event.status !== "done" ? ` · ${event.status}` : ""}
                </s-text>
              </s-stack>
            ))}
            <s-link href="/app/activity">View all activity</s-link>
          </s-stack>
        )}
      </s-section>

      {allDone && data.setupDismissed && (
        <s-section slot="aside" heading="Need help?">
          <s-stack direction="block" gap="small-200">
            <s-button variant="tertiary" onClick={() => submit("show-setup")}>
              Show setup guide
            </s-button>
            <s-link href="/app/settings">Settings and support</s-link>
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}

function SetupStep(props: {
  index: number;
  title: string;
  done: boolean;
  doneLabel?: string;
  optional?: boolean;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <s-box paddingBlock="small-200">
      <s-clickable
        onClick={props.onToggle}
        accessibilityLabel={`${props.title}${props.done ? ", complete" : ""}. ${props.open ? "Collapse" : "Expand"}`}
        borderRadius="base"
        padding="small-200"
      >
        <s-stack
          direction="inline"
          justifyContent="space-between"
          alignItems="center"
        >
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-icon
              type={props.done ? "check-circle-filled" : "circle-dashed"}
              tone={props.done ? "success" : "auto"}
            />
            <s-text type="strong">{props.title}</s-text>
            {props.optional && !props.done && <s-badge>Optional</s-badge>}
            {props.done && props.doneLabel && (
              <s-badge>{props.doneLabel}</s-badge>
            )}
          </s-stack>
          <s-icon
            type={props.open ? "chevron-up" : "chevron-down"}
            color="subdued"
          />
        </s-stack>
      </s-clickable>
      {props.open && (
        <s-box
          paddingInlineStart="large-200"
          paddingInlineEnd="small-200"
          paddingBlock="small-200"
        >
          {props.children}
        </s-box>
      )}
    </s-box>
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label="Setup progress"
      style={{
        height: 6,
        borderRadius: 3,
        background: "var(--p-color-bg-fill-tertiary, #e3e3e3)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${(value / max) * 100}%`,
          height: "100%",
          background: "var(--p-color-bg-fill-inverse, #303030)",
          transition: "width 200ms ease",
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <s-stack direction="inline" justifyContent="space-between">
      <s-text color="subdued">{label}</s-text>
      <s-text type="strong">{value}</s-text>
    </s-stack>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
