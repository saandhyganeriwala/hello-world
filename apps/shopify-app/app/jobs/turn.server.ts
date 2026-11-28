import { Prisma } from "@prisma/client";
import db from "../db.server";
import { buildContext } from "../agent/prompt";
import { openEpisode, runAgentTurn } from "../agent/loop.server";
import { ShopClient } from "../agent/shopify/client.server";
import { SHOP_CONTEXT } from "../agent/shopify/operations";
import type { ToolContext } from "../agent/tools/handlers.server";
import type { Part } from "../agent/llm";
import { localNow } from "../agent/util";
import { decidePendingAction, undoAuditEvent } from "../lib/actions.server";
import { config } from "../lib/config.server";
import { hasFeature, type PlanId } from "../lib/plans";
import {
  destinationFromKey,
  downloadMedia,
  markReadWithTyping,
  sendButtons,
  sendImage,
  sendText,
  type Destination,
} from "../lib/whatsapp-api.server";
import { enqueue } from "./queue.server";

/** Debounce: wait a little for more messages (photos arrive one by one) before taking a turn. */
export async function scheduleTurn(conversationKey: string, delayMs: number) {
  const runAt = new Date(Date.now() + delayMs);
  const queued = await db.job.findFirst({
    where: { conversationKey, status: "queued", kind: "inbound" },
  });
  if (queued) {
    await db.job.update({ where: { id: queued.id }, data: { runAt } });
    return queued.id;
  }
  return (await enqueue("inbound", {}, { conversationKey, runAt })).id;
}

const APPROVAL_RE =
  /^\s*(yes|y|approve|ok|okay|haan|ha|no|n|cancel|reject|nahi|nahin)\b[\s#:-]*(\d{4})?\s*[.!]*\s*$/i;
const YES_WORDS = new Set(["yes", "y", "approve", "ok", "okay", "haan", "ha"]);

export function parseApprovalText(
  text: string | null | undefined,
): { decision: "approve" | "reject"; code: string | null } | null {
  if (!text) return null;
  const m = text.match(APPROVAL_RE);
  if (!m) return null;
  return {
    decision: YES_WORDS.has(m[1].toLowerCase()) ? "approve" : "reject",
    code: m[2] ?? null,
  };
}

/** In a group, Storemate only answers messages that mention it or reply to it. */
export function isAddressedToBot(
  text: string | null | undefined,
  replyToFrom: string | null | undefined,
  botNumber: string,
): boolean {
  const digits = botNumber.replace(/\D/g, "");
  if (replyToFrom && digits && replyToFrom.replace(/\D/g, "") === digits)
    return true;
  if (!text) return false;
  const lower = text.toLowerCase();
  if (lower.includes("storemate")) return true;
  if (digits && text.replace(/[\s-]/g, "").includes(`@${digits}`)) return true;
  return /^\s*\/\w/.test(text); // "/help", "/sales"
}

const HELP_TEXT = [
  "*Storemate help*",
  "- Send product photos with a price to add a product",
  '- "Increase saree prices by 10%"',
  '- "Free shipping above 999"',
  '- "How were sales this week?"',
  "- Reply UNDO to reverse the last change",
].join("\n");

interface InboundPayload {
  id: string;
  type: string;
  from?: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  document?: {
    id: string;
    mime_type?: string;
    caption?: string;
    filename?: string;
  };
  interactive?: { button_reply?: { id: string; title: string } };
  button?: { payload?: string; text?: string };
  context?: { from?: string; id?: string };
}

/** Processes all new messages of one conversation as a single assistant turn. */
export async function processConversationTurn(conversationKey: string) {
  const dest = destinationFromKey(conversationKey);
  const where: Prisma.WaMessageWhereInput =
    dest.kind === "group"
      ? { groupId: dest.groupId, direction: "in", processedAt: null }
      : { waId: dest.waId, groupId: null, direction: "in", processedAt: null };
  const messages = await db.waMessage.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });
  if (!messages.length) return;
  await db.waMessage.updateMany({
    where: { id: { in: messages.map((m) => m.id) } },
    data: { processedAt: new Date() },
  });
  void markReadWithTyping(messages[messages.length - 1].waMessageId);

  // Who is this, and which shop?
  let shopId: string | null = null;
  let groupSubject: string | null = null;
  if (dest.kind === "group") {
    const group = await db.storeGroup.findUnique({
      where: { groupId: dest.groupId },
    });
    if (!group || group.status !== "active") return;
    shopId = group.shopId;
    groupSubject = group.subject;
    await db.storeGroup.update({
      where: { id: group.id },
      data: { lastInboundAt: new Date() },
    });
  } else {
    const user = await db.merchantUser.findFirst({
      where: {
        waId: dest.waId,
        revokedAt: null,
        shop: { uninstalledAt: null },
      },
    });
    if (!user) return;
    shopId = user.shopId;
  }
  const shop = await db.shop.findUniqueOrThrow({
    where: { id: shopId },
    include: { settings: true },
  });
  const plan = shop.plan as PlanId;

  if (plan === "none") {
    await sendText(
      dest,
      "Storemate needs an active plan. Choose one on the Plan page of the Storemate app in your Shopify admin.",
      shop.id,
    );
    return;
  }
  if (dest.kind === "group" && !hasFeature(plan, "group")) {
    await sendText(
      dest,
      "The team group is part of the Group plan. The store owner can switch plans in the Storemate app.",
      shop.id,
    );
    return;
  }

  const api = await ShopClient.forShop(shop.shopDomain);
  await ensureShopFacts(shop, api);

  // Pre-router: approvals, keywords and media without calling the model.
  const agentLines: string[] = [];
  let photos = 0;
  let lastSender: {
    waId: string;
    name: string | null;
    role: "owner" | "staff" | "member";
  } | null = null;
  for (const message of messages) {
    const payload = message.payload as unknown as InboundPayload;
    const sender = await resolveSender(
      shop.id,
      message.waId,
      (payload as { _profileName?: string })._profileName ?? null,
    );
    lastSender = sender;
    const text = message.body;

    const buttonId =
      payload.interactive?.button_reply?.id ?? payload.button?.payload;
    if (buttonId && /^(approve|reject):/.test(buttonId)) {
      const [decision, id] = buttonId.split(":");
      await handleApproval(
        dest,
        shop,
        api,
        sender,
        decision as "approve" | "reject",
        { id },
      );
      continue;
    }
    const approval = parseApprovalText(text);
    if (approval && (approval.code || dest.kind === "dm")) {
      const handled = await handleApproval(
        dest,
        shop,
        api,
        sender,
        approval.decision,
        { code: approval.code },
      );
      if (handled) continue;
    }
    if (text && /^\s*undo\s*$/i.test(text)) {
      await handleUndo(dest, shop, api);
      continue;
    }
    if (text && /^\s*(help|\/help)\s*$/i.test(text)) {
      await sendText(dest, HELP_TEXT, shop.id);
      continue;
    }

    const isMedia =
      (payload.type === "image" && payload.image) ||
      (payload.type === "document" &&
        payload.document?.mime_type?.startsWith("image/"));
    if (isMedia) {
      const media = payload.image ?? payload.document!;
      const downloaded = await downloadMedia(media.id);
      if (downloaded) {
        await db.mediaAsset.create({
          data: {
            shopId: shop.id,
            conversationKey,
            waMediaId: media.id,
            mimeType: downloaded.mimeType,
            caption: media.caption ?? null,
            data: new Uint8Array(downloaded.data),
          },
        });
        photos++;
      }
      if (
        dest.kind === "group" &&
        !isAddressedToBot(
          media.caption,
          payload.context?.from,
          config.whatsapp.displayNumber,
        )
      )
        continue;
      if (media.caption) agentLines.push(prefix(dest, sender, media.caption));
      continue;
    }

    if (
      dest.kind === "group" &&
      !isAddressedToBot(
        text,
        payload.context?.from,
        config.whatsapp.displayNumber,
      )
    )
      continue;
    if (text) agentLines.push(prefix(dest, sender, text));
    else if (payload.type === "audio")
      agentLines.push(
        prefix(dest, sender, "(sent a voice note — ask them to type instead)"),
      );
  }

  const mediaWaiting = await db.mediaAsset.count({
    where: {
      shopId: shop.id,
      conversationKey,
      usedAt: null,
      createdAt: { gte: new Date(Date.now() - 6 * 3600_000) },
    },
  });
  if (!agentLines.length && photos && dest.kind === "dm")
    agentLines.push(`(sent ${photos} photo${photos > 1 ? "s" : ""})`);
  if (!agentLines.length) return;

  const sender = lastSender ?? {
    waId: "",
    name: null,
    role: "member" as const,
  };
  const { episode, previousSummary } = await openEpisode(
    shop.id,
    conversationKey,
  );
  const tz = shop.ianaTimezone ?? "Asia/Kolkata";
  const now = localNow(tz);
  const pending = await db.pendingAction.findMany({
    where: {
      shopId: shop.id,
      conversationKey,
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    select: { summary: true, approvalCode: true },
  });

  const ctx: ToolContext = {
    shop,
    plan,
    approvalMode: shop.settings?.approvalMode ?? "standard",
    api,
    conversationKey,
    actor: sender,
    proposed: [],
  };
  const context = buildContext({
    shopName: shop.name ?? shop.shopDomain,
    shopDomain: shop.shopDomain,
    currency: shop.currencyCode,
    timeZone: tz,
    today: now.date,
    weekday:
      [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ][now.weekday - 1] ?? "",
    plan,
    approvalMode: ctx.approvalMode,
    language: shop.settings?.language ?? "auto",
    memory: (shop.memory as Record<string, string>) ?? {},
    chat: {
      kind: dest.kind,
      senderName: sender.name,
      senderRole: sender.role,
      groupSubject,
    },
    pending: pending.map((p) => ({
      summary: p.summary,
      approvalCode: p.approvalCode ?? "",
    })),
    mediaWaiting,
    previousSummary,
  });

  const userParts: Part[] = [{ type: "text", text: agentLines.join("\n") }];
  let reply: string;
  try {
    reply = (
      await runAgentTurn({ ctx, episodeId: episode.id, userParts, context })
    ).reply;
  } catch (error) {
    console.error("[agent] turn failed", error);
    reply =
      "Sorry, something went wrong on my side. Please try again in a minute.";
  }

  for (const preview of ctx.previews ?? [])
    await sendImage(dest, preview.mediaId, preview.caption, shop.id);
  if (reply) await sendText(dest, reply, shop.id);
  for (const action of ctx.proposed)
    await sendApprovalPrompt(dest, shop.id, action);
}

function prefix(
  dest: Destination,
  sender: { name: string | null },
  text: string,
) {
  return dest.kind === "group"
    ? `${sender.name ?? "Team member"}: ${text}`
    : text;
}

async function resolveSender(
  shopId: string,
  waId: string,
  profileName: string | null,
) {
  const user = waId
    ? await db.merchantUser.findFirst({
        where: { shopId, waId, revokedAt: null },
      })
    : null;
  return {
    waId,
    name: user?.displayName ?? profileName,
    role: (user?.role === "owner" ? "owner" : user ? "staff" : "member") as
      "owner" | "staff" | "member",
  };
}

/** Caches currency, time zone and the Online Store publication id on first use. */
async function ensureShopFacts(
  shop: {
    id: string;
    currencyCode: string | null;
    ianaTimezone: string | null;
    onlineStorePublicationId: string | null;
    name: string | null;
  },
  api: ShopClient,
) {
  if (shop.currencyCode && shop.ianaTimezone && shop.onlineStorePublicationId)
    return;
  const data = await api.query<{
    shop: { name: string; currencyCode: string; ianaTimezone: string };
    publications: { nodes: { id: string; name: string }[] };
  }>(SHOP_CONTEXT);
  const publication = data.publications.nodes.find(
    (p) => p.name.toLowerCase() === "online store",
  );
  const update = {
    name: shop.name ?? data.shop.name,
    currencyCode: data.shop.currencyCode,
    ianaTimezone: data.shop.ianaTimezone,
    onlineStorePublicationId: publication?.id ?? null,
  };
  await db.shop.update({ where: { id: shop.id }, data: update });
  Object.assign(shop, update);
}

export async function sendApprovalPrompt(
  dest: Destination,
  shopId: string,
  action: {
    id: string;
    summary: string;
    diffText: string;
    approvalCode: string;
    minRole: string;
    tool: string;
  },
) {
  const isPublish =
    action.tool === "publish_product" || action.summary.startsWith("Publish");
  const ownerNote =
    action.minRole === "owner"
      ? "\n(Only the store owner can approve this.)"
      : "";
  const body = `*${action.summary}*\n${action.diffText}${ownerNote}`;
  await sendButtons(
    dest,
    body,
    [
      { id: `approve:${action.id}`, title: isPublish ? "Publish" : "Approve" },
      {
        id: `reject:${action.id}`,
        title: isPublish ? "Keep as draft" : "Cancel",
      },
    ],
    `Reply *YES ${action.approvalCode}* to approve or *NO ${action.approvalCode}* to cancel.`,
    shopId,
  );
}

async function handleApproval(
  dest: Destination,
  shop: { id: string },
  api: ShopClient,
  sender: { waId: string; name: string | null; role: string },
  decision: "approve" | "reject",
  ref: { id?: string; code?: string | null },
): Promise<boolean> {
  const conversationKey =
    dest.kind === "group" ? `group:${dest.groupId}` : `dm:${dest.waId}`;
  let action = null;
  if (ref.id) {
    action = await db.pendingAction.findFirst({
      where: { id: ref.id, shopId: shop.id },
    });
  } else if (ref.code) {
    action = await db.pendingAction.findFirst({
      where: { shopId: shop.id, approvalCode: ref.code, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
  } else {
    const candidates = await db.pendingAction.findMany({
      where: {
        shopId: shop.id,
        conversationKey,
        status: "pending",
        expiresAt: { gt: new Date() },
      },
      take: 2,
    });
    if (candidates.length !== 1) return false; // ambiguous: let the assistant handle the message
    action = candidates[0];
  }
  if (!action) {
    await sendText(
      dest,
      "I couldn't find that request. It may have expired.",
      shop.id,
    );
    return true;
  }
  if (
    decision === "approve" &&
    action.minRole === "owner" &&
    sender.role !== "owner"
  ) {
    await sendText(
      dest,
      `Only the store owner can approve “${action.summary}”.`,
      shop.id,
    );
    return true;
  }
  const result = await decidePendingAction({
    graphql: api.graphql,
    shopId: shop.id,
    actionId: action.id,
    decision,
    decidedBy: sender.name ?? sender.waId,
    via: "whatsapp",
  });
  const text = result.ok
    ? decision === "approve"
      ? `Done: ${action.summary}. Reply UNDO to reverse it.`
      : action.summary.startsWith("Publish")
        ? "Kept as a draft. You can publish it any time."
        : `Cancelled: ${action.summary}.`
    : result.message;
  await sendText(dest, text, shop.id);
  return true;
}

async function handleUndo(
  dest: Destination,
  shop: { id: string },
  api: ShopClient,
) {
  const event = await db.auditEvent.findFirst({
    where: {
      shopId: shop.id,
      status: "done",
      createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
      NOT: { undoOps: { equals: Prisma.DbNull } },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!event) {
    await sendText(dest, "There's no recent change I can undo.", shop.id);
    return;
  }
  const result = await undoAuditEvent({
    graphql: api.graphql,
    shopId: shop.id,
    eventId: event.id,
  });
  await sendText(
    dest,
    result.ok ? `Undone: ${event.summary}.` : result.message,
    shop.id,
  );
}
