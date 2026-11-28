import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateLinkCode, linkMessageText, parseLinkCode, waMeLink } from "./link-code";
import { maskPhone } from "./phone";
import { activateEmbedUrl, isEmbedEnabled, stripLeadingComment } from "./theme-embed";
import { verifyMetaSignature } from "./whatsapp-signature";

describe("link codes", () => {
  it("generates 6-character codes from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) expect(generateLinkCode()).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
  });

  it("round-trips through the prefilled message", () => {
    const code = generateLinkCode();
    expect(parseLinkCode(linkMessageText(code))).toBe(code);
  });

  it("tolerates case and spacing", () => {
    expect(parseLinkCode("link 7f3k9q")).toBe("7F3K9Q");
    expect(parseLinkCode("code: LINK-7F3K9Q thanks")).toBe("7F3K9Q");
  });

  it("rejects text without a valid code", () => {
    expect(parseLinkCode("hello")).toBeNull();
    expect(parseLinkCode("LINK-7F3K9")).toBeNull();
    expect(parseLinkCode("LINK-0OIL11")).toBeNull();
    expect(parseLinkCode(undefined)).toBeNull();
  });

  it("builds wa.me links with digits only", () => {
    expect(waMeLink("+91 98100 00000", "a b")).toBe("https://wa.me/919810000000?text=a%20b");
  });
});

describe("maskPhone", () => {
  it("keeps country code and last four digits", () => {
    expect(maskPhone("919812345210")).toBe("+91 ••••• 5210");
    expect(maskPhone("14155550123")).toBe("+1 ••••• 0123");
  });
  it("handles junk", () => {
    expect(maskPhone("12")).toBe("•••");
  });
});

describe("theme embed detection", () => {
  const type = "shopify://apps/storemate/blocks/banner-embed/0b5c-uid";
  const withHeader = (obj: unknown) =>
    `/*\n * IMPORTANT: The contents of this file are auto-generated.\n */\n${JSON.stringify(obj)}`;

  it("strips the generated header comment", () => {
    expect(stripLeadingComment("/* x */ {}")).toBe("{}");
  });

  it("detects an enabled embed", () => {
    expect(isEmbedEnabled(withHeader({ current: { blocks: { "1": { type, disabled: false } } } }))).toBe(true);
    expect(isEmbedEnabled(withHeader({ current: { blocks: { "1": { type } } } }))).toBe(true);
  });

  it("treats a disabled or missing embed as off", () => {
    expect(isEmbedEnabled(withHeader({ current: { blocks: { "1": { type, disabled: true } } } }))).toBe(false);
    expect(isEmbedEnabled(withHeader({ current: { blocks: {} } }))).toBe(false);
    expect(isEmbedEnabled(withHeader({ current: {} }))).toBe(false);
    expect(isEmbedEnabled("not json")).toBe(false);
    expect(isEmbedEnabled(null)).toBe(false);
  });

  it("supports themes whose current settings point to a preset", () => {
    const data = { current: "Default", presets: { Default: { blocks: { a: { type } } } } };
    expect(isEmbedEnabled(withHeader(data))).toBe(true);
  });

  it("ignores other apps and other blocks", () => {
    const other = { current: { blocks: { a: { type: "shopify://apps/other/blocks/reviews/123" } } } };
    expect(isEmbedEnabled(withHeader(other))).toBe(false);
  });

  it("matches the extension uid when given", () => {
    const data = withHeader({ current: { blocks: { a: { type } } } });
    expect(isEmbedEnabled(data, "banner-embed", "0b5c-uid")).toBe(true);
    expect(isEmbedEnabled(data, "banner-embed", "different")).toBe(false);
  });

  it("builds the theme editor activation link", () => {
    expect(activateEmbedUrl("demo.myshopify.com", "abc123")).toBe(
      "https://demo.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=abc123%2Fbanner-embed",
    );
  });
});

describe("verifyMetaSignature", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ object: "whatsapp_business_account" });
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a valid signature", () => {
    expect(verifyMetaSignature(body, sig, secret)).toBe(true);
  });
  it("rejects tampered bodies, wrong secrets and missing headers", () => {
    expect(verifyMetaSignature(body + " ", sig, secret)).toBe(false);
    expect(verifyMetaSignature(body, sig, "other")).toBe(false);
    expect(verifyMetaSignature(body, null, secret)).toBe(false);
    expect(verifyMetaSignature(body, sig, "")).toBe(false);
  });
});
