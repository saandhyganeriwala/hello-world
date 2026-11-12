import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { compress } from "hono/compress";
import fs from "node:fs";
import { assertProdConfig, env } from "./env.js";
import { initDb } from "./db/client.js";
import { api } from "./routes/api.js";
import { billing } from "./routes/billing.js";
import { admin } from "./routes/admin.js";
import { seo } from "./routes/seo.js";
import { iap } from "./routes/iap.js";

assertProdConfig();
await initDb();

const app = new Hono();
// Razorpay Checkout opens popups for some payment methods (UPI apps, netbanking), so allow them.
app.use("*", secureHeaders({ crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false, crossOriginOpenerPolicy: "same-origin-allow-popups" }));

// Compress pages and assets (not /api: live updates stream over server-sent events).
const gzip = compress();
app.use("*", (c, next) => (c.req.path.startsWith("/api/") ? next() : gzip(c, next)));

app.route("/api", admin);
app.route("/api", iap);
app.route("/api", billing);
app.route("/api", api);
const notFoundPage = () => { try { return fs.readFileSync("./public/404.html", "utf8"); } catch { return "Not found"; } };
app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found." }, 404) : c.html(notFoundPage(), 404)));
app.onError((err, c) => {
  console.error("[server] unhandled", err);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

// The app lives at /app; the landing page is everything else.
app.get("/app", serveStatic({ path: "./public/app.html" }));
app.get("/app/*", serveStatic({ path: "./public/app.html" }));
// Policy pages (Razorpay asks for these): /terms, /privacy, /refunds, /contact, /shipping.
app.get("/admin", serveStatic({ path: "./public/admin.html" }));
for (const page of ["terms", "privacy", "refunds", "contact", "shipping", "delete-account"]) {
  app.get(`/${page}`, serveStatic({ path: `./public/${page}.html` }));
}
app.route("/", seo); // /blog, /sitemap.xml, /robots.txt, /llms.txt
app.use("/*", serveStatic({ root: "./public" }));
// Anything else is a real 404 (search engines penalise "soft 404s" that return the home page).

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`CRUD.chat listening on http://localhost:${info.port}`);
});
