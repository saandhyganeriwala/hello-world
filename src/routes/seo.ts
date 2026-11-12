// Everything search engines and AI assistants read: the blog (server-rendered from content/blog/*.md),
// sitemap.xml, robots.txt, llms.txt and an RSS feed. All plain HTML/text — no JavaScript needed to read it.
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { marked } from "marked";
import { env } from "../env.js";

const SITE = (process.env.SITE_URL || "https://crud.chat").replace(/\/$/, "");
const BLOG_DIR = path.resolve("content/blog");
const STATIC_PAGES = [
  { path: "/", priority: "1.0", freq: "weekly" },
  { path: "/blog", priority: "0.8", freq: "weekly" },
  { path: "/contact", priority: "0.4", freq: "yearly" },
  { path: "/terms", priority: "0.3", freq: "yearly" },
  { path: "/privacy", priority: "0.3", freq: "yearly" },
  { path: "/refunds", priority: "0.3", freq: "yearly" },
  { path: "/shipping", priority: "0.3", freq: "yearly" },
  { path: "/delete-account", priority: "0.2", freq: "yearly" },
];

export type Post = { slug: string; title: string; description: string; date: string; keywords: string; html: string; words: number };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function loadPosts(): Post[] {
  if (!fs.existsSync(BLOG_DIR)) return [];
  return fs.readdirSync(BLOG_DIR).filter((f) => f.endsWith(".md")).map((f) => {
    const raw = fs.readFileSync(path.join(BLOG_DIR, f), "utf8");
    const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const meta: Record<string, string> = {};
    for (const line of (m?.[1] ?? "").split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    const body = m?.[2] ?? raw;
    return { slug: f.replace(/\.md$/, ""), title: meta.title || f, description: meta.description || "", date: meta.date || "2026-11-12",
      keywords: meta.keywords || "", html: marked.parse(body, { async: false }) as string, words: body.split(/\s+/).length };
  }).sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
}
let cache: Post[] | null = null;
export const posts = () => (cache && env.isProd ? cache : (cache = loadPosts()));

const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='-3 -1 70 66'%3E%3Crect x='-3' y='-1' width='70' height='66' rx='18' fill='%23FFC31F'/%3E%3Cg stroke='%23141414' stroke-width='3' stroke-linejoin='round' fill='%23A9AFC2'%3E%3Cpath d='M19 21C8 16 1 25 3 35c2 9 10 12 17 7z'/%3E%3Cpath d='M45 21c11-5 18 4 16 14-2 9-10 12-17 7z'/%3E%3Cellipse cx='32' cy='31' rx='17' ry='16'/%3E%3Cpath d='M27.6 38.5c-1.4 7.5-.8 13.6 3.6 16.6 3.6 2.4 8.3.6 7.6-3.4-.3-1.8-2.4-2.2-3.1-.6-.5 1.3-1.7 1.8-2.7 1-1.9-1.6-1.4-7.2.3-13.6z'/%3E%3C/g%3E%3Cellipse cx='25.6' cy='29.6' rx='2.8' ry='3.4' fill='%23141414'/%3E%3Cellipse cx='38.4' cy='29.6' rx='2.8' ry='3.4' fill='%23141414'/%3E%3C/svg%3E";
const fmtDate = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function page(o: { title: string; description: string; path: string; body: string; jsonld?: object[]; type?: string }) {
  const url = SITE + o.path;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="${o.type || "website"}">
<meta property="og:site_name" content="CRUD.chat">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/og.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/og.png">
<link rel="alternate" type="application/rss+xml" title="CRUD.chat blog" href="${SITE}/blog/rss.xml">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=Hanken+Grotesk:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/legal.css">
<link rel="stylesheet" href="/blog.css">
${(o.jsonld || []).map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`).join("\n")}
</head>
<body>
<header><div class="wrap"><a class="brand" href="/"><img src="${FAVICON}" width="28" height="28" alt=""><span>CRUD<b>.chat</b></span></a><nav><a href="/blog">Blog</a><a href="/#pricing">Pricing</a><a class="cta" href="/app">Try free</a></nav></div></header>
<main><div class="wrap">${o.body}</div></main>
<footer><div class="wrap"><nav aria-label="Site"><a href="/">Home</a><a href="/blog">Blog</a><a href="/#pricing">Pricing</a><a href="/contact">Contact</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refunds">Cancellation &amp; refunds</a><a href="/shipping">Delivery</a></nav>
<div>© 2026 Crud · CRUD.chat</div></div></footer>
<script>try{navigator.sendBeacon('/api/t',JSON.stringify({p:location.pathname,r:document.referrer,u:new URLSearchParams(location.search).get('utm_source')||''}))}catch(e){}</script>
</body>
</html>`;
}

const org = { "@type": "Organization", "@id": SITE + "/#org", name: "CRUD.chat", legalName: "Crud", url: SITE, logo: SITE + "/logo.png",
  email: "login@crud.chat", address: { "@type": "PostalAddress", streetAddress: "903, Raheja Willows, Lokhandwala, Kandivali East", addressLocality: "Mumbai", postalCode: "400101", addressRegion: "Maharashtra", addressCountry: "IN" } };

export const seo = new Hono();

seo.get("/blog", (c) => {
  const list = posts();
  const body = `<div class="kicker">Blog</div><h1>Running a small business without the spreadsheet</h1>
<p class="lede">Practical guides for small teams on keeping orders, payments, leads and stock in order — from your phone.</p>
<ul class="posts">${list.map((p) => `<li><a href="/blog/${p.slug}"><span class="pt">${esc(p.title)}</span><span class="pd">${esc(p.description)}</span><span class="pm">${fmtDate(p.date)} · ${Math.max(1, Math.round(p.words / 220))} min read</span></a></li>`).join("")}</ul>`;
  return c.html(page({ title: "Blog · CRUD.chat — guides for small business records", description: "Practical guides for small teams: managing WhatsApp orders, tracking customer dues, simple CRM, inventory, and alternatives to Excel and Google Sheets.", path: "/blog", body,
    jsonld: [{ "@context": "https://schema.org", "@type": "Blog", name: "CRUD.chat blog", url: SITE + "/blog", publisher: org,
      blogPost: list.map((p) => ({ "@type": "BlogPosting", headline: p.title, url: `${SITE}/blog/${p.slug}`, datePublished: p.date })) }] }));
});

seo.get("/blog/rss.xml", (c) => {
  const items = posts().map((p) => `<item><title>${esc(p.title)}</title><link>${SITE}/blog/${p.slug}</link><guid>${SITE}/blog/${p.slug}</guid><pubDate>${new Date(p.date + "T06:00:00Z").toUTCString()}</pubDate><description>${esc(p.description)}</description></item>`).join("");
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>CRUD.chat blog</title><link>${SITE}/blog</link><description>Guides for small business records</description>${items}</channel></rss>`, 200, { "content-type": "application/rss+xml; charset=utf-8" });
});

seo.get("/blog/:slug", (c) => {
  const p = posts().find((x) => x.slug === c.req.param("slug"));
  if (!p) return c.notFound();
  const others = posts().filter((x) => x.slug !== p.slug).slice(0, 3);
  const body = `<nav class="crumbs" aria-label="Breadcrumb"><a href="/blog">Blog</a></nav>
<article><h1>${esc(p.title)}</h1><p class="updated">${fmtDate(p.date)} · ${Math.max(1, Math.round(p.words / 220))} min read · CRUD.chat team</p>
<div class="prose">${p.html}</div></article>
<aside class="cta-box"><p><strong>Keep your records by chat.</strong> Type, speak or send a screenshot — CRUD.chat turns it into orders, payments, leads and tasks your whole team can see.</p><a class="btn" href="/app">Try CRUD.chat free</a></aside>
<h2 class="more">More guides</h2><ul class="posts">${others.map((o) => `<li><a href="/blog/${o.slug}"><span class="pt">${esc(o.title)}</span><span class="pd">${esc(o.description)}</span></a></li>`).join("")}</ul>`;
  return c.html(page({ title: `${p.title} · CRUD.chat`, description: p.description, path: `/blog/${p.slug}`, body, type: "article",
    jsonld: [
      { "@context": "https://schema.org", "@type": "BlogPosting", headline: p.title, description: p.description, datePublished: p.date, dateModified: p.date,
        keywords: p.keywords, wordCount: p.words, image: SITE + "/og.png", mainEntityOfPage: `${SITE}/blog/${p.slug}`, author: org, publisher: org },
      { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: SITE + "/" }, { "@type": "ListItem", position: 2, name: "Blog", item: SITE + "/blog" },
        { "@type": "ListItem", position: 3, name: p.title, item: `${SITE}/blog/${p.slug}` }] },
    ] }));
});

seo.get("/sitemap.xml", (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    ...STATIC_PAGES.map((p) => `<url><loc>${SITE}${p.path}</loc><lastmod>${today}</lastmod><changefreq>${p.freq}</changefreq><priority>${p.priority}</priority></url>`),
    ...posts().map((p) => `<url><loc>${SITE}/blog/${p.slug}</loc><lastmod>${p.date}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`),
  ];
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`, 200, { "content-type": "application/xml; charset=utf-8" });
});

seo.get("/robots.txt", (c) => c.text(`# CRUD.chat — search engines and AI assistants are welcome on public pages.
User-agent: *
Allow: /
Disallow: /app
Disallow: /admin
Disallow: /api/

Sitemap: ${SITE}/sitemap.xml
`));

seo.get("/llms.txt", (c) => {
  const pr = `₹${env.proPriceInr} a month in India (US$${env.proPriceUsd} elsewhere)`;
  return c.text(`# CRUD.chat

> CRUD.chat is a mobile-first web app that small business teams use instead of spreadsheets to keep records. People record orders, payments, leads, tasks or anything else by typing a message, sending a voice note or uploading a screenshot; AI turns each message into a structured record, files it into the right section, answers questions about the data in plain language, and changes the interface on request.

## What it does
- Record by text, voice note or screenshot (e.g. "Order from Kashish 45 Samayi at 500 each, deliver Hyderabad" becomes an order with customer, product, quantity, amount and delivery).
- Sections (Orders, Payments, Leads, Tasks, Inventory, Staff, trackers…) are created automatically from what is recorded.
- Each section can be viewed as a list, table, kanban board, pipeline funnel, calendar, agenda, chart, metrics, ledger, leaderboard or daily tracker, with filters, sorting and grouping.
- Ask questions in plain language ("how much is pending from Hotel Orchid?", "top customers this month") and get answers from the team's own records.
- Change the interface by asking ("show leads as a pipeline", "create a water tracker").
- Shared team workspaces with invite links; changes appear live on everyone's phone.
- Import Excel (.xlsx, .xls) and CSV files; export any section to CSV.
- Works in any modern browser on phone or computer; no app install needed. Messages can be in English or Hinglish.

## Who it is for
Small businesses and teams — traders, wholesalers, distributors, retailers, service businesses, agencies, sales teams — who record work on the go and currently use Excel, Google Sheets, paper registers or WhatsApp notes.

## Pricing
- Free: 10 AI actions per person to try it, up to ${env.freeMembers} people per workspace. Viewing, editing and searching are always free.
- Pro: ${pr} per workspace, billed monthly and cancellable any time; up to ${env.proMembers} people and about 500 AI actions a month (fair use).

## Links
- [Home](${SITE}/): product overview, pricing and FAQ
- [Open the app](${SITE}/app): sign up free with an email code
- [Blog](${SITE}/blog): guides for small business record keeping
${posts().map((p) => `- [${p.title}](${SITE}/blog/${p.slug}): ${p.description}`).join("\n")}
- [Contact](${SITE}/contact): login@crud.chat, Mumbai, India
- [Terms](${SITE}/terms), [Privacy](${SITE}/privacy), [Cancellation & refunds](${SITE}/refunds)
`);
});

// App links: crud.chat/app/... links (e.g. invites) open in the installed app.
//  Android: ANDROID_CERT_SHA256 = the app signing certificate's SHA-256 (Play Console → App integrity), comma-separated.
//  iOS:     APPLE_TEAM_ID = your Apple Developer Team ID; also enable "Associated Domains" (applinks:crud.chat) in Xcode.
const APP_ID = "chat.crud.app";
seo.get("/.well-known/assetlinks.json", (c) => {
  const certs = (process.env.ANDROID_CERT_SHA256 || "").split(",").map((x) => x.trim()).filter(Boolean);
  return c.json(certs.length ? [{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: APP_ID, sha256_cert_fingerprints: certs } }] : []);
});
seo.get("/.well-known/apple-app-site-association", (c) => {
  const team = (process.env.APPLE_TEAM_ID || "").trim();
  return c.json({ applinks: { details: team ? [{ appIDs: [`${team}.${APP_ID}`], components: [{ "/": "/app/*" }, { "/": "/app" }] }] : [] } });
});
seo.get("/manifest.webmanifest", (c) => c.body(fs.readFileSync("./public/manifest.webmanifest", "utf8"), 200, { "content-type": "application/manifest+json; charset=utf-8" }));
