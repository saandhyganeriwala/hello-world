// Numbers for the admin dashboard (/admin). Everything is computed on request from the live tables;
// days are counted in India time. Only admins (ADMIN_EMAILS) can call this — see src/routes/admin.ts.
import crypto from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { pageViews } from "../db/schema.js";
import { env } from "../env.js";
import { GPT_PRICES, GPT_TOKEN_RATIO, gptCostUsd, type TokenSums } from "../ai/compare.js";

const TZ = "Asia/Kolkata";
async function q<T = any>(query: SQL): Promise<T[]> {
  const r: any = await getDb().execute(query);
  return (r.rows ?? r) as T[];
}
const num = (v: unknown) => Number(v ?? 0) || 0;

// ---- visit tracking ----
const BOT = /bot|crawl|spider|slurp|preview|headless|lighthouse|pagespeed|curl|wget|python|axios|node-fetch|go-http|java\/|httpclient|monitor|uptime|facebookexternalhit|whatsapp|telegram|discord|embedly|vercel|railway/i;

export async function trackVisit(input: { path: string; referrer: string; utm: string; ip: string; ua: string; country: string; host: string }) {
  if (!input.ua || BOT.test(input.ua)) return false;
  const path = input.path.slice(0, 120) || "/";
  if (path.startsWith("/admin")) return false;
  const kind = path.startsWith("/app") ? "app" : /^\/(terms|privacy|refunds|contact|shipping)/.test(path) ? "legal" : "landing";
  let referrer: string | null = null;
  try {
    const h = new URL(input.referrer).hostname.replace(/^www\./, "");
    if (h && h !== input.host.replace(/^www\./, "")) referrer = h.slice(0, 80);
  } catch { /* no referrer */ }
  const visitor = crypto.createHash("sha256").update(`${env.sessionSecret}|${input.ip}|${input.ua}`).digest("hex").slice(0, 20);
  await getDb().insert(pageViews).values({
    visitor, kind, path, referrer, utmSource: input.utm.slice(0, 60) || null,
    country: input.country.slice(0, 2).toUpperCase() || null, device: /mobi|android|iphone|ipad/i.test(input.ua) ? "mobile" : "desktop",
  });
  return true;
}

// ---- stats ----
export function percentiles(values: number[]) {
  const v = [...values].sort((a, b) => a - b), n = v.length;
  const at = (p: number) => {
    if (!n) return 0;
    const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return Math.round((v[lo] + (v[hi] - v[lo]) * (i - lo)) * 10) / 10;
  };
  const sum = v.reduce((a, b) => a + b, 0);
  return { n, avg: n ? Math.round((sum / n) * 10) / 10 : 0, median: at(0.5), p75: at(0.75), p90: at(0.9), p99: at(0.99), max: n ? v[n - 1] : 0 };
}
function histogram(values: number[], edges: [number, number, string][]) {
  return edges.map(([lo, hi, label]) => ({ label, count: values.filter((x) => x >= lo && x <= hi).length }));
}

export async function adminStats(days: number) {
  const now = new Date();
  const from = days > 0 ? new Date(now.getTime() - days * 864e5) : new Date("2020-01-01T00:00:00Z");
  const inRange = (col: SQL) => sql`${col} >= ${from.toISOString()}::timestamptz`;
  const day = (col: SQL) => sql`to_char(${col} at time zone ${TZ}, 'YYYY-MM-DD')`;
  const notTranscribe = sql`label <> 'transcribe'`;

  // Traffic
  const [traffic] = await q(sql`select count(*)::int as views, count(distinct visitor)::int as visitors,
      count(distinct visitor) filter (where kind = 'landing')::int as landing_visitors,
      count(distinct visitor) filter (where kind = 'app')::int as app_visitors,
      count(distinct visitor) filter (where device = 'mobile')::int as mobile
    from page_views where ${inRange(sql`created_at`)}`);
  const referrers = await q(sql`select coalesce(referrer, 'Direct / none') as name, count(distinct visitor)::int as visitors
    from page_views where ${inRange(sql`created_at`)} and kind = 'landing' group by 1 order by 2 desc limit 8`);
  const utm = await q(sql`select utm_source as name, count(distinct visitor)::int as visitors
    from page_views where ${inRange(sql`created_at`)} and utm_source is not null group by 1 order by 2 desc limit 8`);
  const countries = await q(sql`select coalesce(country, '—') as name, count(distinct visitor)::int as visitors
    from page_views where ${inRange(sql`created_at`)} group by 1 order by 2 desc limit 8`);

  // Daily series (visitors, signups, actions)
  const dVisitors = await q(sql`select ${day(sql`created_at`)} as d, count(distinct visitor)::int as n from page_views where ${inRange(sql`created_at`)} group by 1`);
  const dSignups = await q(sql`select ${day(sql`created_at`)} as d, count(*)::int as n from users where ${inRange(sql`created_at`)} group by 1`);
  const dActions = await q(sql`select ${day(sql`created_at`)} as d, count(*)::int as n from ai_usage where ${inRange(sql`created_at`)} and ${notTranscribe} group by 1`);
  const firstDay = days > 0 ? from : await firstActivity();
  const series: { day: string; visitors: number; signups: number; actions: number }[] = [];
  const idx = (rows: any[]) => new Map(rows.map((r) => [r.d, num(r.n)]));
  const mv = idx(dVisitors), ms = idx(dSignups), ma = idx(dActions);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  for (let t = firstDay.getTime(); t <= now.getTime() + 1; t += 864e5) {
    const d = fmt.format(new Date(t));
    if (series.length && series[series.length - 1].day === d) continue;
    series.push({ day: d, visitors: mv.get(d) ?? 0, signups: ms.get(d) ?? 0, actions: ma.get(d) ?? 0 });
  }
  const today = fmt.format(now);
  if (series.length && series[series.length - 1].day !== today) series.push({ day: today, visitors: mv.get(today) ?? 0, signups: ms.get(today) ?? 0, actions: ma.get(today) ?? 0 });

  // People
  const [people] = await q(sql`select count(*)::int as total, count(*) filter (where ${inRange(sql`created_at`)})::int as new_users,
      count(*) filter (where free_actions_used >= ${env.freeActions})::int as hit_free_limit from users`);
  const active = async (d: number) => num((await q(sql`select count(distinct user_id)::int as n from messages
      where role = 'user' and user_id is not null and created_at >= now() - (${d} * interval '1 day')`))[0]?.n);
  const [dau, wau, mau] = await Promise.all([active(1), active(7), active(30)]);

  // Funnel for people who signed up in the range
  const [funnel] = await q(sql`with c as (select id from users where ${inRange(sql`created_at`)})
    select (select count(*) from c)::int as signed_up,
      (select count(distinct w.created_by) from workspaces w join c on c.id = w.created_by)::int as made_workspace,
      (select count(distinct m.user_id) from members m join c on c.id = m.user_id)::int as in_workspace,
      (select count(distinct a.user_id) from ai_usage a join c on c.id = a.user_id where a.label <> 'transcribe')::int as used_ai,
      (select count(*) from users u join c on c.id = u.id where u.free_actions_used >= ${env.freeActions})::int as hit_limit,
      (select count(distinct s.user_id) from subscriptions s join c on c.id = s.user_id where s.status in ('active','pending','cancelling','cancelled','completed'))::int as subscribed`);

  // Workspaces
  const [ws] = await q(sql`select count(*)::int as total, count(*) filter (where ${inRange(sql`created_at`)})::int as new_ws from workspaces`);
  const perOwner = (await q(sql`select u.id, count(w.id)::int as n from users u left join workspaces w on w.created_by = u.id group by u.id`)).map((r) => num(r.n));
  const perWorkspace = await q(sql`select w.id, count(m.id)::int as members, count(m.user_id)::int as joined
    from workspaces w left join members m on m.workspace_id = w.id group by w.id`);
  const memberCounts = perWorkspace.map((r) => num(r.members));
  const [inv] = await q(sql`select count(*)::int as total, count(user_id)::int as joined from members`);

  // AI actions per person in the range (everyone who has signed up, and just those who used AI)
  const perUser = (await q(sql`select u.id, count(a.id)::int as n from users u
      left join ai_usage a on a.user_id = u.id and a.label <> 'transcribe' and ${inRange(sql`a.created_at`)} group by u.id`)).map((r) => num(r.n));
  const [ai] = await q(sql`select count(*) filter (where ${notTranscribe})::int as actions, count(*) filter (where label = 'transcribe')::int as transcriptions,
      coalesce(sum(cost_inr), 0)::float8 as cost_inr from ai_usage where ${inRange(sql`created_at`)}`);
  const byLabel = await q(sql`select label as name, count(*)::int as n, coalesce(sum(cost_inr),0)::float8 as cost_inr
    from ai_usage where ${inRange(sql`created_at`)} group by 1 order by 2 desc`);
  const perWsActions = (await q(sql`select w.id, count(a.id)::int as n from workspaces w
      left join ai_usage a on a.workspace_id = w.id and a.label <> 'transcribe' and ${inRange(sql`a.created_at`)} group by w.id`)).map((r) => num(r.n));
  const [content] = await q(sql`select (select count(*) from records where ${inRange(sql`created_at`)})::int as records,
      (select count(*) from messages where role = 'user' and ${inRange(sql`created_at`)})::int as messages`);

  // Money
  const subStatus = await q(sql`select status as name, count(*)::int as n from subscriptions group by 1 order by 2 desc`);
  const [subs] = await q(sql`select
      (select count(*) from workspaces where plan = 'pro' and plan_until > now())::int as pro_workspaces,
      (select count(distinct subscription_id) from payments where status = 'paid' and subscription_id is not null and ${inRange(sql`paid_at`)}
         and paid_at = (select min(p2.paid_at) from payments p2 where p2.subscription_id = payments.subscription_id))::int as new_subs,
      (select count(*) from subscriptions where status in ('cancelling','cancelled') and ${inRange(sql`updated_at`)})::int as cancellations,
      (select coalesce(sum(case when currency = 'INR' then amount / 100.0 else amount / 100.0 * ${env.usdInr} end), 0)
         from subscriptions where status in ('active','pending'))::float8 as mrr_inr,
      (select count(distinct user_id) from payments where status = 'paid')::int as paying_people`);
  const revenue = await q(sql`select currency, coalesce(sum(amount),0)::int as amount, count(*)::int as n
    from payments where status = 'paid' and ${inRange(sql`paid_at`)} group by 1`);
  const revenueAll = await q(sql`select currency, coalesce(sum(amount),0)::int as amount from payments where status = 'paid' group by 1`);

  // Lists
  const topWorkspaces = await q(sql`select w.name, w.plan, w.plan_until > now() as pro, u.email as owner,
      (select count(*) from members m where m.workspace_id = w.id)::int as members,
      (select count(*) from ai_usage a where a.workspace_id = w.id and a.label <> 'transcribe' and ${inRange(sql`a.created_at`)})::int as actions,
      (select count(*) from records r where r.workspace_id = w.id)::int as records, w.created_at
    from workspaces w left join users u on u.id = w.created_by order by actions desc, records desc limit 10`);
  const recentSignups = await q(sql`select u.email, u.phone, u.name, u.created_at, u.free_actions_used as free_used,
      (select count(*) from workspaces w where w.created_by = u.id)::int as workspaces
    from users u order by u.created_at desc limit 12`);

  const toInr = (rows: any[]) => rows.reduce((s, r) => s + (r.currency === "INR" ? num(r.amount) / 100 : (num(r.amount) / 100) * env.usdInr), 0);
  return {
    range: { days, from: from.toISOString(), to: now.toISOString() },
    traffic: { visitors: num(traffic?.visitors), views: num(traffic?.views), landingVisitors: num(traffic?.landing_visitors),
      appVisitors: num(traffic?.app_visitors), mobileShare: traffic?.visitors ? num(traffic.mobile) / num(traffic.visitors) : 0,
      referrers, utm, countries },
    series,
    people: { total: num(people?.total), newUsers: num(people?.new_users), hitFreeLimit: num(people?.hit_free_limit), dau, wau, mau },
    funnel: [
      { label: "Visited the site", n: num(traffic?.visitors) },
      { label: "Signed up", n: num(funnel?.signed_up) },
      { label: "In a workspace", n: num(funnel?.in_workspace) },
      { label: "Used AI", n: num(funnel?.used_ai) },
      { label: "Used all free actions", n: num(funnel?.hit_limit) },
      { label: "Subscribed", n: num(funnel?.subscribed) },
    ],
    workspaces: {
      total: num(ws?.total), newWorkspaces: num(ws?.new_ws),
      perUser: { ...percentiles(perOwner), noWorkspace: perOwner.filter((x) => x === 0).length,
        histogram: histogram(perOwner, [[0, 0, "0"], [1, 1, "1"], [2, 2, "2"], [3, 4, "3–4"], [5, 1e9, "5+"]]) },
      members: { ...percentiles(memberCounts), invited: num(inv?.total) - num(inv?.joined), joined: num(inv?.joined),
        histogram: histogram(memberCounts, [[1, 1, "1"], [2, 2, "2"], [3, 3, "3"], [4, 5, "4–5"], [6, 10, "6–10"], [11, 1e9, "11+"]]) },
    },
    actions: {
      total: num(ai?.actions), transcriptions: num(ai?.transcriptions), costInr: Math.round(num(ai?.cost_inr) * 100) / 100,
      costPerAction: ai?.actions ? Math.round((num(ai.cost_inr) / num(ai.actions)) * 100) / 100 : 0,
      perUserAll: percentiles(perUser), perUserActive: percentiles(perUser.filter((x) => x > 0)), perWorkspace: percentiles(perWsActions.filter((x) => x > 0)),
      histogram: histogram(perUser, [[0, 0, "0"], [1, 2, "1–2"], [3, 5, "3–5"], [6, 10, "6–10"], [11, 25, "11–25"], [26, 50, "26–50"], [51, 100, "51–100"], [101, 1e9, "100+"]]),
      byLabel: byLabel.map((r) => ({ name: r.name, n: num(r.n), costInr: Math.round(num(r.cost_inr) * 100) / 100 })),
      records: num(content?.records), messages: num(content?.messages),
    },
    money: {
      proWorkspaces: num(subs?.pro_workspaces), newSubscriptions: num(subs?.new_subs), cancellations: num(subs?.cancellations),
      mrrInr: Math.round(num(subs?.mrr_inr)), payingPeople: num(subs?.paying_people),
      revenueInr: Math.round(toInr(revenue)), revenueAllInr: Math.round(toInr(revenueAll)), payments: revenue.reduce((s, r) => s + num(r.n), 0),
      subscriptionStatus: subStatus.map((r) => ({ name: r.name, n: num(r.n) })),
    },
    topWorkspaces: topWorkspaces.map((r) => ({ name: r.name, owner: r.owner || "", pro: !!r.pro, members: num(r.members), actions: num(r.actions), records: num(r.records), createdAt: r.created_at })),
    recentSignups: recentSignups.map((r) => ({ who: r.email || r.phone || "", name: r.name || "", createdAt: r.created_at, workspaces: num(r.workspaces), freeUsed: num(r.free_used) })),
  };
}

async function firstActivity() {
  const [r] = await q(sql`select least((select min(created_at) from users), (select min(created_at) from page_views)) as t`);
  const t = r?.t ? new Date(r.t) : new Date();
  return t.getTime() > Date.now() - 864e5 ? new Date(Date.now() - 6 * 864e5) : t;
}

// ---- usage lookup (admin): what used a workspace's AI allowance ----
const r2 = (n: number) => Math.round(n * 100) / 100;
const SUMS = sql`count(*)::int as calls, sum(cost_inr)::float8 as inr, sum(cost_usd)::float8 as usd,
  sum(input_tokens)::float8 as input, sum(output_tokens)::float8 as output, sum(cache_read_tokens)::float8 as cache_read, sum(cache_write_tokens)::float8 as cache_write`;
const sumsOf = (r: any): TokenSums => ({ label: r.label, input: num(r.input), output: num(r.output), cacheRead: num(r.cache_read), cacheWrite: num(r.cache_write), costUsd: num(r.usd) });
function kindRow(r: any) {
  const calls = num(r.calls) || 1, t = sumsOf(r);
  return { label: r.label, calls: num(r.calls), inr: r2(num(r.inr)), avgInr: r2(num(r.inr) / calls),
    avgIn: Math.round(t.input / calls), avgOut: Math.round(t.output / calls), avgCacheRead: Math.round(t.cacheRead / calls), avgCacheWrite: Math.round(t.cacheWrite / calls),
    gptAvgInr: Object.fromEntries(GPT_PRICES.map((p) => [p.id, r2(gptCostUsd(t, p) * env.usdInr / calls)])) };
}
/** Totals for these calls: what they cost on Claude, and what they'd have cost on each GPT model. */
function compareRows(rows: any[]) {
  const actions = rows.filter((r) => r.label !== "transcribe" && r.label !== "custom-view").reduce((n, r) => n + num(r.calls), 0) || 1;
  const claudeInr = rows.reduce((n, r) => n + num(r.inr), 0);
  const line = (id: string, label: string, inr: number) => ({ id, label, inr: r2(inr), perAction: r2(inr / actions), actionsIn225: inr ? Math.floor(env.proMonthlyAiInr / (inr / actions)) : 0 });
  return { actions, models: [line("claude", "Claude (actual)", claudeInr),
    ...GPT_PRICES.map((p) => line(p.id, p.label, rows.reduce((n, r) => n + gptCostUsd(sumsOf(r), p) * env.usdInr, 0)))] };
}
// Finds the workspaces a person (by email or phone) belongs to, and for each one shows the plan, the current
// allowance and where it went: AI cost by kind of request since the period began, and the latest calls.
export async function usageLookup(who: string) {
  const { billingStatus } = await import("./billing.js");
  const key = who.trim().toLowerCase();
  if (!key) return { person: null, workspaces: [] };
  const [person] = await q(sql`select id, name, email, phone, created_at, free_actions_used from users
    where lower(email) = ${key} or phone = ${key} or lower(email) like ${"%" + key + "%"} order by (lower(email) = ${key}) desc limit 1`);
  if (!person) return { person: null, workspaces: [] };
  const wss = await q(sql`select w.id, w.name, w.plan, w.plan_until, w.period_start, w.renews_at, w.bonus_inr, m.role,
      (select count(*) from members x where x.workspace_id = w.id)::int as members,
      (select count(*) from records r where r.workspace_id = w.id)::int as records
    from members m join workspaces w on w.id = m.workspace_id where m.user_id = ${person.id} order by w.created_at`);
  const out = [];
  for (const w of wss) {
    const bill = await billingStatus(w.id);
    const since = new Date(bill.plan === "pro" && bill.periodSince ? bill.periodSince : Date.UTC(2000, 0, 1)).toISOString();
    const byLabel = await q(sql`select label, ${SUMS}
      from ai_usage where workspace_id = ${w.id} and created_at >= ${since}::timestamptz group by label order by inr desc`);
    const recent = await q(sql`select a.created_at, a.label, a.model, a.input_tokens, a.output_tokens, a.cache_read_tokens, a.cache_write_tokens,
        a.cost_inr, a.cost_usd, a.source, a.message_id, u.name as by from ai_usage a left join users u on u.id = a.user_id
      where a.workspace_id = ${w.id} order by a.created_at desc limit 40`);
    out.push({
      id: w.id, name: w.name, role: w.role, members: num(w.members), records: num(w.records),
      plan: bill.plan, planUntil: w.plan_until, periodStart: w.period_start, renewsAt: w.renews_at, bonusInr: num(w.bonus_inr),
      allowance: { ok: bill.ok, usedInr: bill.usedInr, actionsUsed: bill.actionsUsed, actionsLimit: bill.actionsLimit, actionsLeft: bill.actionsLeft,
        periodSince: bill.periodSince ?? null, periodEnds: bill.periodEnds, provider: bill.subscription?.provider ?? null, status: bill.subscription?.status ?? null },
      byLabel: byLabel.map(kindRow),
      compare: compareRows(byLabel),
      recent: recent.map((r) => { const t = { label: r.label, input: num(r.input_tokens), output: num(r.output_tokens), cacheRead: num(r.cache_read_tokens), cacheWrite: num(r.cache_write_tokens), costUsd: num(r.cost_usd) };
        return { at: r.created_at, model: r.model, by: r.by || "", source: r.source || "", messageId: r.message_id || null, ...t,
          inr: r2(num(r.cost_inr)), gpt: Object.fromEntries(GPT_PRICES.map((p) => [p.id, r2(gptCostUsd(t, p) * env.usdInr)])) }; }),
    });
  }
  // Every AI call this person made, in any workspace, since they joined.
  const mine = await q(sql`select label, ${SUMS} from ai_usage where user_id = ${person.id} group by label order by inr desc`);
  return {
    person: { name: person.name || "", contact: person.email || person.phone || "", since: person.created_at, freeActionsUsed: num(person.free_actions_used) },
    allTime: { byLabel: mine.map(kindRow), compare: compareRows(mine) },
    models: GPT_PRICES.map((p) => ({ id: p.id, label: p.label, note: p.note || "", source: p.source || "", in: p.in, cachedIn: p.cachedIn, out: p.out })),
    tokenRatio: GPT_TOKEN_RATIO, actionInr: env.actionInr, budgetInr: env.proMonthlyAiInr,
    workspaces: out,
  };
}
