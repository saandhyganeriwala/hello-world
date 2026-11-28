/**
 * Detects whether this app's app embed block is turned on in a theme's config/settings_data.json.
 *
 * Embed blocks appear under `current.blocks` with a type like
 * `shopify://apps/<app-handle>/blocks/<block-handle>/<extension-uid>` and an optional `disabled` flag.
 * Older themes may store `current` as the name of a preset, in which case blocks live under `presets[name]`.
 */
export const BANNER_EMBED_HANDLE = "banner-embed";

interface Block {
  type?: string;
  disabled?: boolean;
}

/** settings_data.json usually starts with a `/* ... *\/` comment, which JSON.parse rejects. */
export function stripLeadingComment(content: string): string {
  return content.replace(/^\uFEFF?\s*\/\*[\s\S]*?\*\/\s*/, "");
}

export function isEmbedEnabled(
  settingsDataContent: string | null | undefined,
  blockHandle: string = BANNER_EMBED_HANDLE,
  extensionUid?: string,
): boolean {
  if (!settingsDataContent) return false;
  let data: { current?: unknown; presets?: Record<string, unknown> };
  try {
    data = JSON.parse(stripLeadingComment(settingsDataContent));
  } catch {
    return false;
  }
  const current =
    typeof data.current === "string"
      ? data.presets?.[data.current]
      : data.current;
  const blocks = (current as { blocks?: Record<string, Block> } | undefined)
    ?.blocks;
  if (!blocks || typeof blocks !== "object") return false;

  return Object.values(blocks).some((block) => {
    const type = block?.type ?? "";
    if (!type.startsWith("shopify://apps/")) return false;
    if (!type.includes(`/blocks/${blockHandle}/`)) return false;
    if (extensionUid && !type.endsWith(`/${extensionUid}`)) return false;
    return block.disabled !== true;
  });
}

/** Theme editor deep link that opens the App embeds panel with our embed switched on. */
export function activateEmbedUrl(
  shopDomain: string,
  apiKey: string,
  blockHandle = BANNER_EMBED_HANDLE,
): string {
  return `https://${shopDomain}/admin/themes/current/editor?context=apps&activateAppId=${encodeURIComponent(
    `${apiKey}/${blockHandle}`,
  )}`;
}
