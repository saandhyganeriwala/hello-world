import { randomUUID } from "node:crypto";
import db from "../db.server";
import { config, whatsappSendingEnabled } from "./config.server";

/**
 * Thin client for the WhatsApp Cloud API: messages (one-to-one and groups), media and the Groups API.
 * Without credentials (local development) every call is logged and answered with a fake result.
 * References: Cloud API messages; Groups API (requires an Official Business Account).
 */

export type Destination =
  { kind: "dm"; waId: string } | { kind: "group"; groupId: string };

export const conversationKey = (d: Destination) =>
  d.kind === "dm" ? `dm:${d.waId}` : `group:${d.groupId}`;

export function destinationFromKey(key: string): Destination {
  if (key.startsWith("group:")) return { kind: "group", groupId: key.slice(6) };
  return { kind: "dm", waId: key.replace(/^dm:/, "") };
}

export interface GraphResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  data: T;
  mocked?: boolean;
}

async function graph<T = Record<string, unknown>>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<GraphResult<T>> {
  const { graphVersion, accessToken } = config.whatsapp;
  const res = await fetch(
    `https://graph.facebook.com/${graphVersion}/${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const data = (await res.json().catch(() => ({}))) as T;
  if (!res.ok)
    console.error(
      `[whatsapp] ${method} ${path} failed`,
      res.status,
      JSON.stringify(data).slice(0, 500),
    );
  return { ok: res.ok, status: res.status, data };
}

function addressing(d: Destination) {
  return d.kind === "dm"
    ? { recipient_type: "individual", to: d.waId }
    : { recipient_type: "group", to: d.groupId };
}

async function sendMessage(
  d: Destination,
  message: Record<string, unknown>,
  shopId?: string | null,
  logBody?: string,
) {
  const type = String(message.type);
  if (!whatsappSendingEnabled()) {
    console.info(
      `[whatsapp:mock] ${conversationKey(d)} ${type}: ${logBody ?? JSON.stringify(message).slice(0, 300)}`,
    );
    return { ok: true, mocked: true as const, id: `mock.${randomUUID()}` };
  }
  const result = await graph<{ messages?: { id: string }[] }>(
    "POST",
    `${config.whatsapp.phoneNumberId}/messages`,
    {
      messaging_product: "whatsapp",
      ...addressing(d),
      ...message,
    },
  );
  const id = result.data.messages?.[0]?.id;
  if (id) {
    await db.waMessage
      .create({
        data: {
          waMessageId: id,
          direction: "out",
          shopId: shopId ?? null,
          waId: d.kind === "dm" ? d.waId : "",
          groupId: d.kind === "group" ? d.groupId : null,
          type,
          body: logBody ?? null,
          payload: {},
        },
      })
      .catch(() => undefined);
  }
  return { ok: result.ok, mocked: false as const, id };
}

/** WhatsApp text limit is 4096 characters; longer replies are split. */
export async function sendText(
  d: Destination,
  body: string,
  shopId?: string | null,
) {
  const chunks = body.match(/[\s\S]{1,4000}(?=\s|$)|[\s\S]{1,4000}/g) ?? [body];
  let last: Awaited<ReturnType<typeof sendMessage>> | undefined;
  for (const chunk of chunks)
    last = await sendMessage(
      d,
      { type: "text", text: { body: chunk, preview_url: true } },
      shopId,
      chunk,
    );
  return last!;
}

/**
 * Reply buttons (max 3, titles max 20 chars). Groups do not support interactive messages, so for a
 * group destination this falls back to text with typed replies ("YES 4821").
 */
export async function sendButtons(
  d: Destination,
  body: string,
  buttons: { id: string; title: string }[],
  fallbackText: string,
  shopId?: string | null,
) {
  if (d.kind === "group")
    return sendText(d, `${body}\n\n${fallbackText}`, shopId);
  return sendMessage(
    d,
    {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1024) },
        action: {
          buttons: buttons
            .slice(0, 3)
            .map((b) => ({
              type: "reply",
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
        },
      },
    },
    shopId,
    `${body} [${buttons.map((b) => b.title).join(" | ")}]`,
  );
}

export async function sendImage(
  d: Destination,
  mediaId: string,
  caption: string,
  shopId?: string | null,
) {
  return sendMessage(
    d,
    { type: "image", image: { id: mediaId, caption } },
    shopId,
    `[image] ${caption}`,
  );
}

/** Template message, for business-initiated messages outside the 24-hour window. */
export async function sendTemplate(
  d: Destination,
  name: string,
  language: string,
  bodyParams: string[],
  shopId?: string | null,
) {
  return sendMessage(
    d,
    {
      type: "template",
      template: {
        name,
        language: { code: language },
        components: bodyParams.length
          ? [
              {
                type: "body",
                parameters: bodyParams.map((text) => ({ type: "text", text })),
              },
            ]
          : [],
      },
    },
    shopId,
    `[template ${name}] ${bodyParams.join(" | ")}`,
  );
}

/** Marks an inbound message read and shows the typing indicator while the assistant works. */
export async function markReadWithTyping(messageId: string) {
  if (
    !whatsappSendingEnabled() ||
    messageId.startsWith("mock.") ||
    messageId.startsWith("sim.")
  )
    return;
  await graph("POST", `${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: "whatsapp",
    status: "read",
    message_id: messageId,
    typing_indicator: { type: "text" },
  }).catch(() => undefined);
}

/** Downloads inbound media: GET /{media-id} for a short-lived URL, then fetch it with the token. */
export async function downloadMedia(
  mediaId: string,
): Promise<{ data: Buffer; mimeType: string } | null> {
  if (!whatsappSendingEnabled()) return null;
  const meta = await graph<{ url?: string; mime_type?: string }>(
    "GET",
    mediaId,
  );
  if (!meta.ok || !meta.data.url) return null;
  const res = await fetch(meta.data.url, {
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
  });
  if (!res.ok) return null;
  return {
    data: Buffer.from(await res.arrayBuffer()),
    mimeType: meta.data.mime_type ?? "image/jpeg",
  };
}

/** Uploads an image so it can be sent as a preview. Returns the WhatsApp media id. */
export async function uploadMedia(
  data: Buffer,
  mimeType: string,
): Promise<string | null> {
  if (!whatsappSendingEnabled()) return `mock-media-${randomUUID()}`;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append(
    "file",
    new Blob([new Uint8Array(data)], { type: mimeType }),
    "preview.jpg",
  );
  const res = await fetch(
    `https://graph.facebook.com/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/media`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
      body: form,
    },
  );
  const json = (await res.json().catch(() => ({}))) as { id?: string };
  return json.id ?? null;
}

// ------------------------------------------------------------------ Groups API

/**
 * Creates a group. The group id and invite link arrive asynchronously in a `group_lifecycle_update`
 * webhook (type "group_create"); the response carries a request id to match it.
 */
export async function createGroup(subject: string, description: string) {
  if (!whatsappSendingEnabled()) {
    return {
      ok: true,
      mocked: true as const,
      requestId: `mock-req-${randomUUID()}`,
    };
  }
  const result = await graph<{ request_id?: string; id?: string }>(
    "POST",
    `${config.whatsapp.phoneNumberId}/groups`,
    {
      messaging_product: "whatsapp",
      subject: subject.slice(0, 128),
      description: description.slice(0, 2048),
      join_approval_mode: "auto_approve",
    },
  );
  return {
    ok: result.ok,
    mocked: false as const,
    requestId: result.data.request_id ?? null,
    groupId: result.data.id ?? null,
    error: result.ok ? null : result.data,
  };
}

export async function getInviteLink(groupId: string) {
  if (!whatsappSendingEnabled())
    return `https://chat.whatsapp.com/mock${groupId.slice(-8)}`;
  const result = await graph<{ invite_link?: string }>(
    "GET",
    `${groupId}/invite_link`,
  );
  return result.data.invite_link ?? null;
}

/** Resetting invalidates all previous invite links. */
export async function resetInviteLink(groupId: string) {
  if (!whatsappSendingEnabled())
    return `https://chat.whatsapp.com/mock${randomUUID().slice(0, 8)}`;
  const result = await graph<{ invite_link?: string }>(
    "POST",
    `${groupId}/invite_link`,
    { messaging_product: "whatsapp" },
  );
  return result.data.invite_link ?? null;
}

/** Removed participants can no longer rejoin with the invite link. */
export async function removeParticipants(
  groupId: string,
  participants: { waId?: string | null; userId?: string | null }[],
) {
  if (!whatsappSendingEnabled()) return true;
  const result = await graph("DELETE", `${groupId}/participants`, {
    messaging_product: "whatsapp",
    participants: participants.map((p) =>
      p.waId ? { user: p.waId } : { user_id: p.userId },
    ),
  });
  return result.ok;
}

export async function deleteGroup(groupId: string) {
  if (!whatsappSendingEnabled()) return true;
  const result = await graph("DELETE", groupId);
  return result.ok;
}

export async function getGroupInfo(groupId: string) {
  if (!whatsappSendingEnabled()) return null;
  const result = await graph<{
    subject?: string;
    suspended?: boolean;
    total_participant_count?: number;
    participants?: { wa_id?: string; user_id?: string; username?: string }[];
  }>(
    "GET",
    `${groupId}?fields=subject,suspended,participants,total_participant_count`,
  );
  return result.ok ? result.data : null;
}
