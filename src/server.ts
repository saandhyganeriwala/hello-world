import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { assertProdConfig, env } from "./env.js";
import { initDb } from "./db/client.js";
import { api } from "./routes/api.js";

assertProdConfig();
await initDb();

const app = new Hono();
app.use("*", secureHeaders({ crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));

app.route("/api", api);
app.notFound((c) => (c.req.path.startsWith("/api/") ? c.json({ error: "Not found." }, 404) : c.text("Not found", 404)));
app.onError((err, c) => {
  console.error("[server] unhandled", err);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});

// The app itself: static files, with index.html for any other path.
app.use("/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ path: "./public/index.html" }));

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`CRUD.chat listening on http://localhost:${info.port}`);
});
