import type { Prisma } from "@prisma/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { config } from "../lib/config.server";
import { parseLinkCode } from "../lib/link-code";
import { verifyMetaSignature } from "../lib/whatsapp-signature";
import {
  LINK_FAILED_REPLY,
  NOT_LINKED_REPLY,
  connectedWelcome,
  consumeLinkCode,
  findActiveMerchant,
  sendText,
} from "../lib/whatsapp.server";
import {
  onGroupCreateFailed,
  onGroupCreated,
  onGroupDeleted,
  onParticipantsAdded,
  onParticipantsRemoved,
} from "../lib/groups.server";
import { scheduleTurn } from "../jobs/turn.server";

/** Meta webhook verification handshake. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (
    mode === "subscribe" &&
    token &&
    config.whatsapp.verifyToken &&
    token === config.whatsapp.verifyToken
  ) {
    return new Response(challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return new Response("Forbidden", { status: 403 });
};

export interface InboundMessage {
  id: string;
  from?: string;
  from_user_id?: string;
  group_id?: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; caption?: string; mime_type?: string };
  document?: { id: string; caption?: string; mime_type?: string };
  interactive?: {
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  button?: { payload?: string; text?: string };
  context?: { from?: string; id?: string };
}

interface GroupEvent {
  type: string;
  group_id?: string;
  request_id?: string;
  subject?: string;
  invite_link?: string;
  added_participants?: {
    wa_id?: string;
    user_id?: string;
    username?: string;
  }[];
  removed_participants?: { wa_id?: string; user_id?: string }[];
  errors?: unknown;
}

interface WebhookBody {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: {
          wa_id?: string;
          user_id?: string;
          profile?: { name?: string };
        }[];
        messages?: InboundMessage[];
        groups?: GroupEvent[];
        statuses?: unknown[];
      };
    }[];
  }[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const raw = await request.text();
  if (
    !verifyMetaSignature(
      raw,
      request.headers.get("x-hub-signature-256"),
      config.whatsapp.appSecret,
    )
  ) {
    return new Response("Invalid signature", { status: 401 });
  }
  let body: WebhookBody;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      if (
        config.whatsapp.phoneNumberId &&
        value.metadata?.phone_number_id &&
        value.metadata.phone_number_id !== config.whatsapp.phoneNumberId
      )
        continue;

      for (const event of value.groups ?? []) {
        try {
          await handleGroupEvent(event);
        } catch (error) {
          console.error("[whatsapp] group event failed", event.type, error);
        }
      }
      for (const message of value.messages ?? []) {
        const contact = value.contacts?.find(
          (c) =>
            (message.from && c.wa_id === message.from) ||
            (message.from_user_id && c.user_id === message.from_user_id),
        );
        try {
          if (message.group_id)
            await handleGroupMessage(message, contact?.profile?.name);
          else await handleDirectMessage(message, contact?.profile?.name);
        } catch (error) {
          // Never fail the webhook for one bad message: Meta would retry the whole batch.
          console.error(
            "[whatsapp] failed to handle message",
            message.id,
            error,
          );
        }
      }
    }
  }
  return new Response("ok", { status: 200 });
};

async function handleGroupEvent(event: GroupEvent) {
  switch (event.type) {
    case "group_create":
      if (event.group_id && !event.errors)
        await onGroupCreated({
          requestId: event.request_id,
          groupId: event.group_id,
          inviteLink: event.invite_link,
          subject: event.subject,
        });
      else
        await onGroupCreateFailed({
          requestId: event.request_id,
          error: event.errors,
        });
      break;
    case "group_delete":
      if (event.group_id) await onGroupDeleted(event.group_id);
      break;
    case "group_participants_add":
      if (event.group_id)
        await onParticipantsAdded(
          event.group_id,
          event.added_participants ?? [],
        );
      break;
    case "group_participants_remove":
      if (event.group_id)
        await onParticipantsRemoved(
          event.group_id,
          event.removed_participants ?? [],
        );
      break;
    default:
      break; // settings/status updates are not used yet
  }
}

function textOf(message: InboundMessage): string | undefined {
  return (
    message.text?.body ??
    message.image?.caption ??
    message.document?.caption ??
    message.interactive?.button_reply?.title ??
    message.button?.text
  );
}

/** Photos usually arrive one by one: wait a bit longer after media so they become one turn. */
function turnDelay(message: InboundMessage) {
  if (message.interactive || message.button) return 0;
  return message.type === "image" || message.type === "document"
    ? 12_000
    : 1_500;
}

async function storeInbound(
  message: InboundMessage,
  shopId: string | null,
  profileName?: string,
) {
  try {
    await db.waMessage.create({
      data: {
        waMessageId: message.id,
        direction: "in",
        shopId,
        waId: message.from ?? message.from_user_id ?? "",
        groupId: message.group_id ?? null,
        type: message.type,
        body: textOf(message) ?? null,
        payload: {
          ...message,
          _profileName: profileName ?? null,
        } as unknown as Prisma.InputJsonValue,
      },
    });
    return true;
  } catch {
    return false; // duplicate delivery
  }
}

async function handleDirectMessage(
  message: InboundMessage,
  profileName?: string,
) {
  const from = message.from ?? "";
  const merchant = from ? await findActiveMerchant(from) : null;
  if (!(await storeInbound(message, merchant?.shopId ?? null, profileName)))
    return;

  const code = parseLinkCode(textOf(message));
  if (code) {
    await db.waMessage.update({
      where: { waMessageId: message.id },
      data: { processedAt: new Date() },
    });
    const result = await consumeLinkCode(code, from, profileName);
    if (result.ok) {
      await db.merchantUser.updateMany({
        where: { shopId: result.shopId, waId: from },
        data: { lastInboundAt: new Date() },
      });
      await db.waMessage.update({
        where: { waMessageId: message.id },
        data: { shopId: result.shopId },
      });
      await sendText(from, connectedWelcome(result.shopName), result.shopId);
    } else {
      await sendText(from, LINK_FAILED_REPLY[result.reason]);
    }
    return;
  }

  if (!merchant) {
    await db.waMessage.update({
      where: { waMessageId: message.id },
      data: { processedAt: new Date() },
    });
    await sendText(from, NOT_LINKED_REPLY);
    return;
  }
  await db.merchantUser.update({
    where: { id: merchant.id },
    data: { lastInboundAt: new Date() },
  });
  await scheduleTurn(`dm:${from}`, turnDelay(message));
}

async function handleGroupMessage(
  message: InboundMessage,
  profileName?: string,
) {
  const group = await db.storeGroup.findUnique({
    where: { groupId: message.group_id! },
  });
  if (!group || group.status !== "active") return;
  if (!(await storeInbound(message, group.shopId, profileName))) return;
  await db.storeGroup.update({
    where: { id: group.id },
    data: { lastInboundAt: new Date() },
  });
  await scheduleTurn(`group:${message.group_id}`, turnDelay(message));
}
