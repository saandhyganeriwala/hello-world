import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";

import db from "../db.server";
import { authenticate } from "../shopify.server";
import { decidePendingAction, undoAuditEvent } from "../lib/actions.server";
import { ensureShop } from "../lib/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin.graphql);

  const [pending, events] = await Promise.all([
    db.pendingAction.findMany({
      where: {
        shopId: shop.id,
        status: "pending",
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    }),
    db.auditEvent.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  return {
    pending: pending.map((p) => ({
      id: p.id,
      summary: p.summary,
      diffText: p.diffText,
      createdAt: p.createdAt.toISOString(),
      expiresAt: p.expiresAt.toISOString(),
    })),
    events: events.map((e) => ({
      id: e.id,
      summary: e.summary,
      actor: e.actor,
      status: e.status,
      canUndo: e.status === "done" && e.undoOps !== null,
      createdAt: e.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop, admin.graphql);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = String(form.get("id"));
  const who =
    session.onlineAccessInfo?.associated_user?.email ?? "Shopify admin";

  if (intent === "approve" || intent === "reject") {
    return decidePendingAction({
      graphql: admin.graphql,
      shopId: shop.id,
      actionId: id,
      decision: intent,
      decidedBy: who,
      via: "admin",
    });
  }
  if (intent === "undo")
    return undoAuditEvent({
      graphql: admin.graphql,
      shopId: shop.id,
      eventId: id,
    });
  return { ok: false, message: "Unknown action" };
};

const ACTOR_LABEL: Record<string, string> = {
  agent: "Storemate",
  merchant: "You",
  system: "System",
};
const STATUS: Record<string, { label: string; tone?: "critical" | "neutral" }> =
  {
    done: { label: "Done" },
    failed: { label: "Failed", tone: "critical" },
    undone: { label: "Undone", tone: "neutral" },
  };

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Activity() {
  const { pending, events } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Activity">
      <s-section heading="Waiting for your approval">
        {pending.length === 0 ? (
          <s-text color="subdued">
            Nothing waiting. When Storemate needs your OK, it shows up here and
            in WhatsApp.
          </s-text>
        ) : (
          <s-stack direction="block" gap="base">
            {pending.map((item) => (
              <PendingCard key={item.id} item={item} />
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="History" padding="none">
        {events.length === 0 ? (
          <s-box padding="base">
            <s-text color="subdued">No activity yet.</s-text>
          </s-box>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Change</s-table-header>
              <s-table-header>By</s-table-header>
              <s-table-header>When</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header>
                <s-text accessibilityVisibility="exclusive">Actions</s-text>
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {events.map((event) => (
                <s-table-row key={event.id}>
                  <s-table-cell>{event.summary}</s-table-cell>
                  <s-table-cell>
                    {ACTOR_LABEL[event.actor] ?? event.actor}
                  </s-table-cell>
                  <s-table-cell>{formatDate(event.createdAt)}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS[event.status]?.tone}>
                      {STATUS[event.status]?.label ?? event.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    {event.canUndo ? <UndoButton id={event.id} /> : null}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

function useResultToast(data: { ok: boolean; message?: string } | undefined) {
  const shopify = useAppBridge();
  useEffect(() => {
    if (data?.message) shopify.toast.show(data.message, { isError: !data.ok });
  }, [data, shopify]);
}

function PendingCard({
  item,
}: {
  item: { id: string; summary: string; diffText: string; expiresAt: string };
}) {
  const fetcher = useFetcher<{ ok: boolean; message?: string }>();
  useResultToast(fetcher.data);
  const busy = fetcher.state !== "idle";
  const decide = (intent: "approve" | "reject") =>
    fetcher.submit({ intent, id: item.id }, { method: "POST" });

  return (
    <s-box border="base" borderRadius="base" padding="base">
      <s-stack direction="block" gap="small-200">
        <s-text type="strong">{item.summary}</s-text>
        <s-box background="subdued" borderRadius="base" padding="small-200">
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", font: "inherit" }}>
            {item.diffText}
          </pre>
        </s-box>
        <s-stack
          direction="inline"
          justifyContent="space-between"
          alignItems="center"
        >
          <s-text color="subdued">Expires {formatDate(item.expiresAt)}</s-text>
          <s-stack direction="inline" gap="small-200">
            <s-button
              onClick={() => decide("reject")}
              {...(busy ? { disabled: true } : {})}
            >
              Cancel
            </s-button>
            <s-button
              variant="primary"
              onClick={() => decide("approve")}
              {...(busy ? { loading: true } : {})}
            >
              Approve
            </s-button>
          </s-stack>
        </s-stack>
      </s-stack>
    </s-box>
  );
}

function UndoButton({ id }: { id: string }) {
  const fetcher = useFetcher<{ ok: boolean; message?: string }>();
  useResultToast(fetcher.data);
  return (
    <s-button
      variant="tertiary"
      icon="undo"
      {...(fetcher.state !== "idle" ? { loading: true } : {})}
      onClick={() => fetcher.submit({ intent: "undo", id }, { method: "POST" })}
    >
      Undo
    </s-button>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
