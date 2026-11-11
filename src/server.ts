import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { assertProdConfig, env } from "./env.js";
import { initDb } from "./db/client.js";
import { api } from "./routes/api.js";
import { billing } from "./routes/billing.js";

assertProdConfig();
await initDb();

const app = new Hono();
// Razorpay Checkout opens popups for some payment methods (UPI apps, netbanking), so allow them.
app.use("*", secureHeaders({ crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false, crossOriginOpenerPolicy: "same-origin-allow-popups" }));

app.route("/api", billing);
app.route("/api", api);
app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found." }, 404) : c.text("Not found", 404)));
app.onError((err, c) => {
  console.error("[server] unhandled", err);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

// The app lives at /app; the landing page is everything else.
app.get("/app", serveStatic({ path: "./public/app.html" }));
app.get("/app/*", serveStatic({ path: "./public/app.html" }));
// Policy pages (Razorpay asks for these): /terms, /privacy, /refunds, /contact, /shipping.
for (const page of ["terms", "privacy", "refunds", "contact", "shipping"]) {
  app.get(`/${page}`, serveStatic({ path: `./public/${page}.html` }));
}
app.use("/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ path: "./public/index.html" }));

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`CRUD.chat listening on http://localhost:${info.port}`);
});
