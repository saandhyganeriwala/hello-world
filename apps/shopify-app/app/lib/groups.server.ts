import { randomUUID } from "node:crypto";
import db from "../db.server";
import { config, whatsappSendingEnabled } from "./config.server";
import { GROUP_MAX_PARTICIPANTS } from "./plans";
import * as wa from "./whatsapp-api.server";

/**
 * Store team group (Group plan) on top of Meta's Groups API:
 * - Storemate's number creates the group; Meta sends the group id and invite link by webhook.
 * - Businesses cannot add people directly. Members join with the invite link (Meta's rule), which the
 *   owner shares from the Storemate app or receives in their WhatsApp chat.
 * - Groups allow up to 8 participants, text/media/template messages only (no buttons), and need an
 *   Official Business Account.
 */

export async function getStoreGroup(shopId: string) {
  return db.storeGroup.findUnique({
    where: { shopId },
    include: {
      participants: { where: { leftAt: null }, orderBy: { joinedAt: "asc" } },
    },
  });
}

export async function createStoreGroup(shop: {
  id: string;
  name: string | null;
  shopDomain: string;
}) {
  const existing = await db.storeGroup.findUnique({
    where: { shopId: shop.id },
  });
  if (existing && existing.status !== "deleted" && existing.status !== "failed")
    return existing;

  const subject =
    `${shop.name ?? shop.shopDomain.replace(".myshopify.com", "")} × Storemate`.slice(
      0,
      128,
    );
  const description =
    "Your store team and Storemate. Mention Storemate (or reply to its messages) to ask it to do something. " +
    "It asks before publishing or changing prices, shipping or discounts.";
  const result = await wa.createGroup(subject, description);
  if (!result.ok) {
    const error = JSON.stringify(
      (result as { error?: unknown }).error ?? "create failed",
    ).slice(0, 500);
    return db.storeGroup.upsert({
      where: { shopId: shop.id },
      create: { shopId: shop.id, subject, status: "failed", error },
      update: {
        subject,
        status: "failed",
        error,
        groupId: null,
        inviteLink: null,
      },
    });
  }

  const group = await db.storeGroup.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      subject,
      requestId: result.requestId,
      status: "creating",
    },
    update: {
      subject,
      requestId: result.requestId,
      status: "creating",
      error: null,
      groupId: null,
      inviteLink: null,
    },
  });
  await db.groupParticipant.updateMany({
    where: { storeGroupId: group.id, leftAt: null },
    data: { leftAt: new Date() },
  });

  // Without Meta credentials, simulate the creation webhook so the flow can be tried locally.
  if (result.mocked) {
    await onGroupCreated({
      requestId: result.requestId!,
      groupId: `mock-group-${randomUUID().slice(0, 8)}`,
      inviteLink: null,
      subject,
    });
  }
  return db.storeGroup.findUniqueOrThrow({ where: { id: group.id } });
}

/** group_lifecycle_update / group_create. */
export async function onGroupCreated(event: {
  requestId?: string | null;
  groupId: string;
  inviteLink?: string | null;
  subject?: string;
}) {
  const group =
    (event.requestId
      ? await db.storeGroup.findFirst({ where: { requestId: event.requestId } })
      : null) ??
    (event.subject
      ? await db.storeGroup.findFirst({
          where: { subject: event.subject, status: "creating" },
        })
      : null);
  if (!group) return null;
  const inviteLink =
    event.inviteLink ?? (await wa.getInviteLink(event.groupId));
  const updated = await db.storeGroup.update({
    where: { id: group.id },
    data: { groupId: event.groupId, inviteLink, status: "active", error: null },
  });
  await shareInviteWithOwner(updated.shopId, inviteLink);
  return updated;
}

export async function onGroupCreateFailed(event: {
  requestId?: string | null;
  error?: unknown;
}) {
  if (!event.requestId) return;
  await db.storeGroup.updateMany({
    where: { requestId: event.requestId },
    data: {
      status: "failed",
      error: JSON.stringify(event.error ?? "failed").slice(0, 500),
    },
  });
}

export async function onGroupDeleted(groupId: string) {
  await db.storeGroup.updateMany({
    where: { groupId },
    data: { status: "deleted", inviteLink: null },
  });
}

export async function onParticipantsAdded(
  groupId: string,
  participants: { wa_id?: string; user_id?: string; username?: string }[],
) {
  const group = await db.storeGroup.findUnique({
    where: { groupId },
    include: { participants: { where: { leftAt: null } } },
  });
  if (!group) return;
  const firstJoin = group.participants.length === 0;
  for (const p of participants) {
    const existing = group.participants.find(
      (x) =>
        (p.wa_id && x.waId === p.wa_id) ||
        (p.user_id && x.userId === p.user_id),
    );
    if (existing) continue;
    await db.groupParticipant.create({
      data: {
        storeGroupId: group.id,
        waId: p.wa_id ?? null,
        userId: p.user_id ?? null,
        name: p.username ?? null,
      },
    });
  }
  if (firstJoin) {
    await wa.sendText(
      { kind: "group", groupId },
      "Hi team, I'm Storemate. Mention *Storemate* in a message (or reply to one of mine) to ask me to add products, " +
        "change prices or shipping, or check sales. I'll ask before making big changes: reply YES with the code I give.",
      group.shopId,
    );
  }
}

export async function onParticipantsRemoved(
  groupId: string,
  participants: { wa_id?: string; user_id?: string }[],
) {
  const group = await db.storeGroup.findUnique({ where: { groupId } });
  if (!group) return;
  for (const p of participants) {
    await db.groupParticipant.updateMany({
      where: {
        storeGroupId: group.id,
        leftAt: null,
        OR: [
          ...(p.wa_id ? [{ waId: p.wa_id }] : []),
          ...(p.user_id ? [{ userId: p.user_id }] : []),
        ],
      },
      data: { leftAt: new Date() },
    });
  }
}

export async function resetStoreGroupInvite(shopId: string) {
  const group = await db.storeGroup.findUnique({ where: { shopId } });
  if (!group?.groupId) return null;
  const inviteLink = await wa.resetInviteLink(group.groupId);
  return db.storeGroup.update({
    where: { id: group.id },
    data: { inviteLink },
  });
}

export async function removeStoreGroupParticipant(
  shopId: string,
  participantId: string,
) {
  const group = await db.storeGroup.findUnique({ where: { shopId } });
  const participant = await db.groupParticipant.findFirst({
    where: { id: participantId, storeGroupId: group?.id ?? "" },
  });
  if (!group?.groupId || !participant) return false;
  const ok = await wa.removeParticipants(group.groupId, [
    { waId: participant.waId, userId: participant.userId },
  ]);
  if (ok)
    await db.groupParticipant.update({
      where: { id: participant.id },
      data: { leftAt: new Date() },
    });
  return ok;
}

export async function deleteStoreGroup(shopId: string) {
  const group = await db.storeGroup.findUnique({ where: { shopId } });
  if (!group) return;
  if (group.groupId) await wa.deleteGroup(group.groupId);
  await db.storeGroup.update({
    where: { id: group.id },
    data: { status: "deleted", inviteLink: null },
  });
  await db.groupParticipant.updateMany({
    where: { storeGroupId: group.id, leftAt: null },
    data: { leftAt: new Date() },
  });
}

/** Sends the invite link to the owner's one-to-one chat, if the owner messaged us in the last 24 hours. */
async function shareInviteWithOwner(shopId: string, inviteLink: string | null) {
  if (!inviteLink) return;
  const owner = await db.merchantUser.findFirst({
    where: { shopId, revokedAt: null, role: "owner" },
  });
  if (!owner) return;
  const windowOpen =
    owner.lastInboundAt &&
    Date.now() - owner.lastInboundAt.getTime() < 23 * 3600_000;
  if (windowOpen || !whatsappSendingEnabled()) {
    await wa.sendText(
      { kind: "dm", waId: owner.waId },
      `Your store team group is ready. Join it, then share this link with up to ${GROUP_MAX_PARTICIPANTS - 1} teammates:\n${inviteLink}`,
      shopId,
    );
  } else if (config.whatsapp.templates.groupInvite) {
    // Utility template from Meta's Template Library ("Group invite link"); the group id becomes the link.
    const group = await db.storeGroup.findUnique({ where: { shopId } });
    if (group?.groupId)
      await sendGroupInviteTemplate(owner.waId, group.groupId, shopId);
  }
}

export async function sendGroupInviteTemplate(
  toWaId: string,
  groupId: string,
  shopId: string,
) {
  if (!config.whatsapp.templates.groupInvite) return false;
  if (!whatsappSendingEnabled()) return true;
  const res = await fetch(
    `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toWaId,
        type: "template",
        template: {
          name: config.whatsapp.templates.groupInvite,
          language: { code: config.whatsapp.templates.language },
          components: [
            {
              type: "body",
              parameters: [{ type: "group_id", group_id: groupId }],
            },
          ],
        },
      }),
    },
  );
  if (!res.ok)
    console.error(
      "[groups] invite template failed",
      res.status,
      await res.text().catch(() => ""),
    );
  void shopId;
  return res.ok;
}

/** Plain data for the TeamGroup admin card. */
export async function buildGroupInfo(shopId: string) {
  const group = await getStoreGroup(shopId);
  if (!group || group.status === "deleted") return null;
  const { default: QRCode } = await import("qrcode");
  const qrSvg = group.inviteLink
    ? await QRCode.toString(group.inviteLink, {
        type: "svg",
        margin: 0,
        errorCorrectionLevel: "M",
        color: { dark: "#000000", light: "#ffffff" },
      })
    : null;
  const { maskPhone } = await import("./phone");
  return {
    status: group.status as "creating" | "active" | "failed",
    subject: group.subject,
    inviteLink: group.inviteLink,
    qrSvg,
    error: group.error,
    max: GROUP_MAX_PARTICIPANTS,
    participants: group.participants.map((p) => ({
      id: p.id,
      label: p.name ?? (p.waId ? maskPhone(p.waId) : "Member"),
      joinedAt: p.joinedAt.toISOString(),
    })),
  };
}
