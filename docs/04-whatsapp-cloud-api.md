# 4. WhatsApp Cloud API Integration (direct, no BSP)

Base URL: `https://graph.facebook.com/{version}/`. Pin the latest Graph API version when the build
starts and upgrade at least once a year.

## 4.1 One-time setup

1. Meta Business Manager account, **business verification** (needed for display-name approval and higher messaging tiers).
2. Meta developer app of type Business with the WhatsApp product added. Create a WABA and register the platform phone number.
3. A **system user** with a permanent token, permissions `whatsapp_business_messaging` and `whatsapp_business_management`.
   Store the token in the server environment only.
4. Subscribe the app to WABA webhooks, field `messages`.
5. Submit message templates (4.5). Set the display name to the brand name, for example "Storemate".

## 4.2 Webhook

**Verification (GET)**: echo `hub.challenge` when `hub.mode == "subscribe"` and `hub.verify_token` matches our secret.

**Delivery (POST)**:

```ts
// apps/web/app/routes/webhooks.whatsapp.ts (sketch)
export async function action({ request }: ActionFunctionArgs) {
  const raw = await request.text();
  const sig = request.headers.get("x-hub-signature-256") ?? "";
  const expected = "sha256=" + crypto.createHmac("sha256", env.META_APP_SECRET).update(raw).digest("hex");
  if (!timingSafeEqualStr(sig, expected)) return new Response("bad signature", { status: 401 });

  const body = JSON.parse(raw);
  for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) {
    const v = change.value;
    for (const msg of v.messages ?? []) {
      // insert ... on conflict (wa_message_id) do nothing  -> dedupe Meta retries
      if (await saveInbound(msg, v.metadata.phone_number_id, v.contacts?.[0]))
        await boss.send("inbound", { waMessageId: msg.id }, { singletonKey: await shopKeyFor(msg.from) });
    }
    for (const st of v.statuses ?? []) await saveStatus(st); // sent, delivered, read, failed (with error codes)
  }
  return new Response("ok"); // respond fast; Meta retries non-2xx with backoff
}
```

Inbound message types we handle:

| `type` | Handling |
|---|---|
| `text` | Agent input |
| `image` (`image.id`, `mime_type`, `sha256`, `caption`) | Added to the media batch. The caption counts as text. |
| `document` with an image MIME type | Treated as a full-quality image (merchants are encouraged to send photos as documents) |
| `interactive.button_reply` / `interactive.list_reply` | Pre-router: approvals and choices (`id` = `approve:<action_id>`) |
| `button` (template quick reply) | Same as above, for replies to template messages |
| `audio` | v1: "Please type your request." v2: transcription. |
| `reaction`, `location`, `sticker`, `contacts` | Acknowledged and ignored |
| `unsupported` / errors | Logged |

## 4.3 Media

```text
GET /{media-id}                 (Bearer system-user token)  -> { url, mime_type, sha256, file_size }
GET {url}                       (Bearer token; the URL expires in about 5 minutes) -> bytes
POST /{phone-number-id}/media   multipart (file, type, messaging_product=whatsapp) -> { id }   # for previews
```

- Download as soon as the job runs, check the `sha256`, store in R2 under `shop/{id}/batch/{id}/{n}`.
- Limits: images 5 MB (JPEG/PNG); documents up to 100 MB. Downscale previews before uploading.
- Media batching: the first image opens a batch. Each further image or caption extends it by 25 s. A text
  message, or the timer running out, closes it and starts the agent with all of its media.

## 4.4 Outbound messages

`POST /{phone-number-id}/messages`, always with `"messaging_product": "whatsapp"`.

| Use | Payload |
|---|---|
| Reply text | `{type:"text", to, text:{body, preview_url:true}}`. WhatsApp formatting only: `*bold*`, `_italic_`, lists. No tables. |
| Read receipt and typing indicator | `{status:"read", message_id, typing_indicator:{type:"text"}}`. Sent as soon as the job starts. |
| Approval | `{type:"interactive", interactive:{type:"button", body:{text: diff}, action:{buttons:[{type:"reply", reply:{id:"approve:act_123", title:"Approve"}}, {type:"reply", reply:{id:"reject:act_123", title:"Cancel"}}]}}}`. At most 3 buttons, titles up to 20 characters. |
| Choice from many | `interactive.type = "list"`, up to 10 rows |
| Image preview | `{type:"image", image:{id: <uploaded media id>, caption}}` |
| Template (outside the 24-hour window) | `{type:"template", template:{name, language:{code}, components:[...]}}` |

**24-hour customer-service window**: free-form messages are allowed only within 24 hours of the merchant's
last message. Outside it, use an approved template. The agent tracks `last_inbound_at` per merchant user. If the
window has closed and a job finishes later (a long bulk operation, say), it sends the `task_update` template.

## 4.5 Templates to register (utility category)

| Name | Variables | Used for |
|---|---|---|
| `weekly_summary` | name, week, revenue, orders, AOV, top product | Monday summary (buttons: "Details", "Pause summaries") |
| `task_update` | task, status | A long-running job finished outside the window |
| `approval_pending` | action summary | Reminder for an approval still pending after 12 h |
| `checkout_recovery_digest` | count, value | "6 abandoned checkouts worth ₹8,240. Reply to see drafts." |

Keep the wording purely informational, with no promotions, so Meta keeps them in the utility category. The
merchant can switch these off in the embedded app.

## 4.6 Merchant↔shop linking (no OTP cost)

1. The embedded app shows "Connect WhatsApp" with a QR code and a button linking to
   `https://wa.me/<platform_number>?text=LINK-7F3K9Q`. The code is one-time, expires after 10 minutes and is tied to the shop and staff user.
2. The merchant sends it. The webhook matches the code and binds `wa_id` to the shop. The first owner gets the owner role.
3. Because the merchant started the conversation, the reply is free and opens the service window.
4. More staff are linked the same way. Owners can revoke numbers in the admin app.

## 4.7 Customer-facing messages (abandoned checkouts)

- **v1 (zero cost, no extra compliance burden)**: the agent drafts each message and returns a
  `https://wa.me/<customer_phone>?text=<urlencoded draft>` link. The merchant taps it and sends from their own
  WhatsApp or WhatsApp Business app. The merchant stays responsible for consent with their own customers.
- **v2**: the app becomes a **Meta Tech Provider**. Merchants connect their own WABA through
  **Embedded Signup**, we send marketing templates through the Cloud API on their behalf (still direct, no
  BSP), and Meta bills their WABA. Only customers with WhatsApp marketing opt-in are messaged. Needs Meta App Review.

## 4.8 Reliability

- Outbound: retry 5xx and 429 with backoff. Treat errors `131047` (re-engagement needed, window closed) and
  `131026` (undeliverable) as terminal. Fall back to a template where possible.
- Ordering: all of one shop's outbound messages go through its serial queue.
- Monitor the platform number's quality rating and messaging tier through the WABA API, and alert on drops.
