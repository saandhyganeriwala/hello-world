/**
 * End-to-end pipeline test against a real Postgres (skipped without DATABASE_URL):
 * signed WhatsApp webhook -> job queue -> conversation turn -> tools on the in-memory fake store ->
 * approval prompt -> button approval -> applied change -> UNDO, plus group rules.
 *
 * The LLM is a scripted stand-in that returns fixed tool calls, so this checks our plumbing, not model quality.
 */
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);
process.env.FAKE_SHOPIFY_STORE = "1";
process.env.META_APP_SECRET = "test-secret";
process.env.WHATSAPP_DISPLAY_NUMBER = "+91 98100 00000";
process.env.SHOPIFY_API_KEY ??= "test";
process.env.SHOPIFY_API_SECRET ??= "test";
process.env.SHOPIFY_APP_URL ??= "http://localhost";

type Script = (call: number, req: { messages: { role: string; parts: { type: string; content?: string }[] }[]; context?: string }) => {
  parts: { type: string; [k: string]: unknown }[];
  stop: "end" | "tool_use";
};

describe.skipIf(!hasDb)("WhatsApp to Shopify pipeline", () => {
  const owner = `9198${Math.floor(10000000 + Math.random() * 89999999)}`;
  const shopDomain = `pipeline-${randomUUID().slice(0, 8)}.myshopify.com`;
  const groupId = `grp-${randomUUID().slice(0, 8)}`;
  const sent: string[] = [];
  let script: Script = () => ({ parts: [{ type: "text", text: "ok" }], stop: "end" });
  let llmCalls = 0;
  let db: typeof import("../db.server").default;
  let shopId = "";

  beforeAll(async () => {
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.startsWith("[whatsapp:mock]")) sent.push(line);
    });
    const llm = await import("../agent/llm");
    llm.setProvider({
      name: "anthropic",
      async complete(model, req) {
        const out = script(llmCalls++, req as never);
        return {
          provider: "anthropic",
          model,
          parts: out.parts as never,
          native: out.parts,
          stop: out.stop,
          usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000, cacheWriteTokens: 0 },
        };
      },
    });
    db = (await import("../db.server")).default;
    const shop = await db.shop.create({
      data: { shopDomain, name: "Kavya Ethnic Wear", plan: "group", currencyCode: "INR", ianaTimezone: "Asia/Kolkata", onlineStorePublicationId: "gid://shopify/Publication/1", settings: { create: {} } },
    });
    shopId = shop.id;
    await db.merchantUser.create({ data: { shopId, waId: owner, displayName: "Kavya", role: "owner" } });
    await db.storeGroup.create({ data: { shopId, groupId, subject: "Kavya × Storemate", status: "active", inviteLink: "https://chat.whatsapp.com/x" } });
  });

  afterAll(async () => {
    if (!db) return;
    await db.job.deleteMany({ where: { conversationKey: { in: [`dm:${owner}`, `group:${groupId}`] } } });
    await db.shop.deleteMany({ where: { id: shopId } });
    await db.$disconnect();
  });

  async function postWebhook(messages: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
    const { action } = await import("../routes/webhooks.whatsapp");
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "1" }, contacts: [{ wa_id: owner, profile: { name: "Kavya" } }], messages, ...extra } }] }],
    });
    const sig = "sha256=" + createHmac("sha256", "test-secret").update(body).digest("hex");
    const res = await action({ request: new Request("http://x/webhooks/whatsapp", { method: "POST", body, headers: { "x-hub-signature-256": sig } }) } as never);
    expect(res.status).toBe(200);
  }

  /** Runs queued jobs for a conversation now (ignores debounce delays). */
  async function drain(conversationKey: string) {
    await db.job.updateMany({ where: { conversationKey, status: "queued" }, data: { runAt: new Date(0) } });
    const { claimNext, complete } = await import("./queue.server");
    const { runJob } = await import("./worker.server");
    for (;;) {
      const job = await claimNext();
      if (!job) break;
      await runJob(job);
      await complete(job.id);
    }
  }

  it("rejects an unsigned webhook", async () => {
    const { action } = await import("../routes/webhooks.whatsapp");
    const res = await action({ request: new Request("http://x", { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256=00" } }) } as never);
    expect(res.status).toBe(401);
  });

  it("turns a price request into an approval, applies it on tap, and undoes it", async () => {
    const { fakeStoreState } = await import("../dev/fake-store.server");
    script = (call) => {
      if (call === 0) return { parts: [{ type: "tool_call", id: "c1", name: "search_products", input: { query: "saree" } }], stop: "tool_use" };
      if (call === 1)
        return {
          parts: [{ type: "tool_call", id: "c2", name: "update_prices", input: { product_ids: ["gid://shopify/Product/2", "gid://shopify/Product/3"], percent_change: 10 } }],
          stop: "tool_use",
        };
      return { parts: [{ type: "text", text: "I'll raise both sarees by 10%. Please approve." }], stop: "end" };
    };
    await postWebhook([{ id: `wamid.${randomUUID()}`, from: owner, timestamp: "1", type: "text", text: { body: "Increase saree prices by 10%" } }]);
    await drain(`dm:${owner}`);

    const pending = await db.pendingAction.findFirstOrThrow({ where: { shopId, status: "pending" } });
    expect(pending.tool).toBe("update_prices");
    expect(pending.diffText).toContain("₹4,499 → ₹4,949");
    expect(sent.some((l) => l.includes("Please approve"))).toBe(true);
    expect(sent.some((l) => l.includes("interactive") && l.includes("[Approve | Cancel]"))).toBe(true);
    expect(await db.llmUsage.count({ where: { shopId } })).toBe(3);

    // Merchant taps Approve: no LLM call, frozen operations run.
    const before = llmCalls;
    await postWebhook([{ id: `wamid.${randomUUID()}`, from: owner, timestamp: "2", type: "interactive", interactive: { button_reply: { id: `approve:${pending.id}`, title: "Approve" } } }]);
    await drain(`dm:${owner}`);
    expect(llmCalls).toBe(before);
    expect(fakeStoreState.products.find((p) => p.id === "gid://shopify/Product/2")!.variants[0].price).toBe("4949.00");
    expect(sent.some((l) => l.includes("Done: Change prices for 2 products"))).toBe(true);

    // UNDO restores the previous prices.
    await postWebhook([{ id: `wamid.${randomUUID()}`, from: owner, timestamp: "3", type: "text", text: { body: "undo" } }]);
    await drain(`dm:${owner}`);
    expect(fakeStoreState.products.find((p) => p.id === "gid://shopify/Product/2")!.variants[0].price).toBe("4499.00");
    expect(sent.some((l) => l.includes("Undone: Change prices"))).toBe(true);
  });

  it("in the group, ignores chatter, answers mentions and takes typed approvals", async () => {
    const calls = llmCalls;
    const groupMsg = (text: string) => ({ id: `wamid.${randomUUID()}`, from: owner, group_id: groupId, timestamp: "4", type: "text", text: { body: text } });

    await postWebhook([groupMsg("lunch at 2?")]);
    await drain(`group:${groupId}`);
    expect(llmCalls).toBe(calls); // not addressed: no model call

    script = (call) => {
      if (call === calls) return { parts: [{ type: "tool_call", id: "g1", name: "set_store_banner", input: { enabled: true, text: "Diwali sale 20% off" } }], stop: "tool_use" };
      return { parts: [{ type: "text", text: "Banner ready for approval." }], stop: "end" };
    };
    await postWebhook([groupMsg("Storemate add a banner: Diwali sale 20% off")]);
    await drain(`group:${groupId}`);
    const pending = await db.pendingAction.findFirstOrThrow({ where: { shopId, status: "pending", tool: "set_store_banner" } });
    expect(sent.some((l) => l.includes(`group:${groupId}`) && l.includes(`YES ${pending.approvalCode}`))).toBe(true);

    await postWebhook([groupMsg(`YES ${pending.approvalCode}`)]);
    await drain(`group:${groupId}`);
    const { fakeStoreState } = await import("../dev/fake-store.server");
    expect(JSON.parse(fakeStoreState.banner!)).toMatchObject({ enabled: true, text: "Diwali sale 20% off" });
  });

  it("gates Group-plan tools on the Solo plan", async () => {
    await db.shop.update({ where: { id: shopId }, data: { plan: "solo" } });
    let toolResult = "";
    script = (call, req) => {
      const last = req.messages[req.messages.length - 1];
      const result = last.parts.find((p) => p.type === "tool_result");
      if (result) {
        toolResult = result.content ?? "";
        return { parts: [{ type: "text", text: "That's on the Group plan." }], stop: "end" };
      }
      return { parts: [{ type: "tool_call", id: "s1", name: "list_abandoned_checkouts", input: { since: "2026-11-01" } }], stop: "tool_use" };
    };
    await postWebhook([{ id: `wamid.${randomUUID()}`, from: owner, timestamp: "5", type: "text", text: { body: "show abandoned checkouts" } }]);
    await drain(`dm:${owner}`);
    expect(toolResult).toContain("plan_required");

    // Group messages are refused politely on Solo.
    await postWebhook([{ id: `wamid.${randomUUID()}`, from: owner, group_id: groupId, timestamp: "6", type: "text", text: { body: "Storemate hi" } }]);
    await drain(`group:${groupId}`);
    expect(sent.some((l) => l.includes("part of the Group plan"))).toBe(true);
  });

  it("handles group lifecycle webhooks", async () => {
    const { createStoreGroup } = await import("../lib/groups.server");
    await db.shop.update({ where: { id: shopId }, data: { plan: "group" } });
    await db.storeGroup.update({ where: { shopId }, data: { status: "deleted" } });
    const created = await createStoreGroup({ id: shopId, name: "Kavya", shopDomain });
    // Mock mode simulates Meta's group_create webhook immediately.
    expect(created.status).toBe("active");
    expect(created.groupId).toMatch(/^mock-group-/);
    await postWebhook([], { groups: [{ type: "group_participants_add", group_id: created.groupId, added_participants: [{ wa_id: owner, user_id: "IN.1" }] }] });
    const participants = await db.groupParticipant.count({ where: { storeGroupId: created.id, leftAt: null } });
    expect(participants).toBe(1);
    expect(sent.some((l) => l.includes(`group:${created.groupId}`) && l.includes("I'm Storemate"))).toBe(true);
  });
});
