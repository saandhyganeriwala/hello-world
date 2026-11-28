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

/** Meta webhook verification handshake. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && config.whatsapp.verifyToken && token === config.whatsapp.verifyToken) {
    return new Response(challenge ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
};

interface InboundMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { caption?: string };
  document?: { caption?: string };
  interactive?: { button_reply?: { id: string; title: string }; list_reply?: { id: string; title: string } };
}

interface WebhookBody {
  object?: string;
  entry?: {
    changes?: {
      value?: {
        metadata?: { phone_number_id?: string };
        contacts?: { wa_id: string; profile?: { name?: string } }[];
        messages?: InboundMessage[];
        statuses?: unknown[];
      };
    }[];
  }[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const raw = await request.text();
  if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"), config.whatsapp.appSecret)) {
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
      if (!value?.messages) continue; // delivery statuses are ignored for now
      if (config.whatsapp.phoneNumberId && value.metadata?.phone_number_id !== config.whatsapp.phoneNumberId) continue;

      for (const message of value.messages) {
        const contact = value.contacts?.find((c) => c.wa_id === message.from);
        try {
          await handleMessage(message, contact?.profile?.name);
        } catch (error) {
          // Never fail the webhook for one bad message: Meta would retry the whole batch.
          console.error("[whatsapp] failed to handle message", message.id, error);
        }
      }
    }
  }
  return new Response("ok", { status: 200 });
};

function textOf(message: InboundMessage): string | undefined {
  return message.text?.body ?? message.image?.caption ?? message.document?.caption ?? message.interactive?.button_reply?.title;
}

async function handleMessage(message: InboundMessage, profileName?: string) {
  const text = textOf(message);
  const merchant = await findActiveMerchant(message.from);

  // Dedupe Meta retries: the unique index on waMessageId makes a repeat insert fail.
  try {
    await db.waMessage.create({
      data: {
        waMessageId: message.id,
        direction: "in",
        shopId: merchant?.shopId ?? null,
        waId: message.from,
        type: message.type,
        body: text ?? null,
        payload: message as unknown as Prisma.InputJsonValue,
      },
    });
  } catch {
    return; // already processed
  }

  const code = parseLinkCode(text);
  if (code) {
    const result = await consumeLinkCode(code, message.from, profileName);
    if (result.ok) {
      await db.waMessage.update({ where: { waMessageId: message.id }, data: { shopId: result.shopId } });
      await sendText(message.from, connectedWelcome(result.shopName), result.shopId);
    } else {
      await sendText(message.from, LINK_FAILED_REPLY[result.reason]);
    }
    return;
  }

  if (!merchant) {
    await sendText(message.from, NOT_LINKED_REPLY);
    return;
  }

  await db.merchantUser.update({ where: { id: merchant.id }, data: { lastInboundAt: new Date() } });

  // Next milestone (M2/M3): enqueue for the per-shop agent worker, which handles approvals,
  // media batches and the assistant itself. Until then messages are stored but not answered.
  console.info(`[whatsapp] stored message ${message.id} for shop ${merchant.shop.shopDomain}; agent worker not yet enabled`);
}
