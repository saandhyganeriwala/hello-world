// CRUD.chat service worker: makes the site installable and shows a friendly page when offline.
// It only steps in for page loads that fail — everything else (API, live updates, assets) goes straight to the network.
// It also receives things shared to the installed app (manifest share_target): the files are kept in a cache
// for a moment and the app picks them up at /app?share=1.
const CACHE = "crud-offline-v1";
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.add("/offline.html"))); self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname === "/app/share-target") { e.respondWith(keepShared(e.request)); return; }
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => caches.match("/offline.html")));
});

async function keepShared(request) {
  try {
    const form = await request.formData(), cache = await caches.open("crud-share");
    for (const k of await cache.keys()) await cache.delete(k);
    let i = 0;
    for (const f of form.getAll("files")) {
      if (!f || typeof f === "string") continue;
      await cache.put(`/__share/${i++}`, new Response(f, { headers: { "content-type": f.type || "application/octet-stream", "x-name": encodeURIComponent(f.name || "file") } }));
    }
    const text = ["title", "text", "url"].map((k) => form.get(k)).filter((v) => typeof v === "string" && v.trim())
      .filter((v, j, a) => a.indexOf(v) === j).join("\n");
    if (text) await cache.put("/__share/text", new Response(text, { headers: { "content-type": "text/plain" } }));
  } catch (err) { /* nothing kept */ }
  return Response.redirect("/app?share=1", 303);
}
