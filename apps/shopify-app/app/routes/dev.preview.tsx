import { Outlet } from "react-router";

/**
 * Development-only layout for previewing admin screens with sample data, outside the Shopify admin.
 * Loads Polaris web components from Shopify's CDN and stubs the App Bridge `shopify` global.
 */
export const loader = async () => {
  if (process.env.NODE_ENV === "production") throw new Response("Not found", { status: 404 });
  return null;
};

const STUB = `window.shopify = window.shopify || { toast: { show: function (m) { console.log("[toast]", m); } } };`;

export default function PreviewLayout() {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: STUB }} />
      <script src="https://cdn.shopify.com/shopifycloud/polaris.js" />
      <div style={{ background: "#f1f1f1", minHeight: "100vh", paddingBlock: 16 }}>
        <Outlet />
      </div>
    </>
  );
}
