import { randomUUID } from "node:crypto";
import type pg from "pg";
import { TEMPLATES, addDays, instantiate, todayIn } from "@bca/shared";
import { audit } from "../lib/audit.js";
import { availableBaseMetrics, loadAvailability } from "../metrics/engine.js";
import { saveNewDashboard } from "../dashboards/store.js";

/**
 * Demo mode. Creates a separate, clearly labelled demo business with seeded sample
 * data from five simulated sources. Demo data only ever lives in businesses with
 * is_demo = true (enforced by a database trigger on connections), so it can never
 * be mixed into a real business.
 */

const DAYS = 400;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHANNELS = [["Organic Search", 0.34], ["Paid Search", 0.22], ["Direct", 0.18], ["Paid Social", 0.11], ["Email", 0.1], ["Referral", 0.05]] as const;
const COUNTRIES = [["United States", 0.62], ["Canada", 0.11], ["United Kingdom", 0.09], ["Australia", 0.06], ["Germany", 0.05], ["France", 0.03], ["Netherlands", 0.02], ["Other", 0.02]] as const;
const PRODUCTS = [
  ["Trailhead Rain Jacket", 0.17, 149], ["Summit Down Vest", 0.13, 119], ["Ridge Merino Base Layer", 0.12, 79], ["Canyon Hiking Boots", 0.11, 189],
  ["Alpine Daypack 24L", 0.1, 89], ["Basecamp Fleece", 0.09, 69], ["Trail Running Socks (3-pack)", 0.08, 24], ["Granite Softshell Pants", 0.07, 99],
  ["Camp Mug Set", 0.06, 29], ["Headlamp 400", 0.07, 39],
] as const;
const CAMPAIGNS = [
  ["Search – Brand", "Search", 85, 9.5, 1.8], ["Search – Generic", "Search", 240, 2.6, 1.1], ["Shopping – All Products", "Shopping", 360, 3.7, 0.9],
  ["Performance Max", "Performance Max", 300, 3.2, 0.7], ["Display – Remarketing", "Display", 65, 2.1, 0.45],
] as const;
const QUERIES = [
  ["aurora outfitters", 0.21, 1.4], ["rain jacket men", 0.08, 9.8], ["waterproof hiking boots", 0.07, 11.2], ["merino base layer", 0.07, 7.6], ["down vest women", 0.06, 12.4],
  ["best daypack for hiking", 0.06, 14.9], ["fleece jacket sale", 0.05, 16.3], ["trail running socks", 0.05, 8.1], ["softshell pants", 0.04, 13.7], ["camping mug set", 0.03, 18.4],
  ["headlamp rechargeable", 0.04, 21.6], ["hiking gear checklist", 0.24, 24.8],
] as const;
const PAGES = [["/", 0.24], ["/collections/jackets", 0.14], ["/products/trailhead-rain-jacket", 0.11], ["/blog/hiking-gear-checklist", 0.18], ["/collections/footwear", 0.1], ["/products/canyon-hiking-boots", 0.08], ["/blog/layering-guide", 0.09], ["/collections/sale", 0.06]] as const;
const STAGES = [["Appointment scheduled", 0.32], ["Qualified to buy", 0.27], ["Proposal sent", 0.24], ["Contract sent", 0.17]] as const;
const SOURCES = [["google / organic", 0.38], ["newsletter / email", 0.22], ["google / cpc", 0.18], ["(direct) / (none)", 0.12], ["instagram / social", 0.1]] as const;

/** Split an integer total across weighted buckets so the parts sum exactly to the total. */
function splitInt(total: number, weights: readonly number[], r: () => number): number[] {
  const w = weights.map((x) => x * (0.85 + r() * 0.3));
  const sum = w.reduce((a, b) => a + b, 0);
  const raw = w.map((x) => (x / sum) * total);
  const floors = raw.map(Math.floor);
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (rest-- <= 0) break;
    floors[i]!++;
  }
  return floors;
}

/** Split a money total (2 decimals) exactly. */
const splitMoney = (total: number, weights: readonly number[], r: () => number) => splitInt(Math.round(total * 100), weights, r).map((c) => c / 100);
const money = (n: number) => Math.round(n * 100) / 100;

interface Row { asset: string; conn: string; provider: string; metric: string; date: string; dimKey: string; dimValue: string; value: number; currency: string | null }

export async function createDemoBusiness(db: pg.PoolClient, workspaceId: string, userId: string, currency = "USD", timezone = "America/New_York") {
  const businessId = randomUUID();
  await db.query(
    `INSERT INTO businesses (id, workspace_id, name, industry, website, timezone, currency, description, is_demo, created_by)
     VALUES ($1, $2, 'Aurora Outfitters (Demo)', 'ecommerce', 'https://example.com', $3, $4, $5, true, $6)`,
    [businessId, workspaceId, timezone, currency,
      "DEMO BUSINESS — every number here is generated sample data, not a real company. An outdoor apparel brand selling online, mainly in North America, with a small wholesale pipeline.",
      userId],
  );

  // One demo connection + asset per simulated source.
  const sources = [
    ["shopify", "aurora-outfitters.myshopify.com", "store", "Aurora Outfitters store"],
    ["ga4", "GA4 · Aurora Outfitters", "property", "aurora-outfitters.com – GA4"],
    ["gsc", "Search Console", "site", "sc-domain:aurora-outfitters.com"],
    ["google_ads", "Google Ads 123-456-7890", "customer", "Aurora Outfitters Ads"],
    ["hubspot", "HubSpot portal 4455667", "portal", "Aurora Outfitters CRM"],
  ] as const;
  const ids: Record<string, { conn: string; asset: string }> = {};
  const today = todayIn(timezone);
  for (const [provider, display, kind, assetName] of sources) {
    const conn = randomUUID();
    const asset = randomUUID();
    ids[provider] = { conn, asset };
    await db.query(
      `INSERT INTO connections (id, workspace_id, business_id, provider, display_name, external_account_id, status, is_demo, last_success_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', true, now(), $7)`,
      [conn, workspaceId, businessId, provider, `${display} (demo)`, `demo-${provider}`, userId],
    );
    await db.query(
      `INSERT INTO connection_assets (id, workspace_id, business_id, connection_id, provider_asset_id, name, kind, currency, timezone, selected, latest_data_date, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, now())`,
      [asset, workspaceId, businessId, conn, `demo-${provider}-asset`, assetName, kind, currency, timezone, addDays(today, -1)],
    );
  }

  const r = rng(0x5eed);
  const rows: Row[] = [];
  const push = (provider: string, metric: string, date: string, value: number, dimKey = "", dimValue = "", isMoney = false) =>
    rows.push({ asset: ids[provider]!.asset, conn: ids[provider]!.conn, provider, metric, date, dimKey, dimValue, value, currency: isMoney ? currency : null });

  // Open pipeline evolves slowly (snapshot metric).
  let pipelineDeals = 38;
  let pipelineValue = 96_000;

  for (let i = DAYS; i >= 1; i--) {
    const date = addDays(today, -i);
    const d = new Date(`${date}T00:00:00Z`);
    const dow = d.getUTCDay();
    const month = d.getUTCMonth();
    const growth = 1 + (DAYS - i) * 0.0009;
    const weekly = dow === 0 || dow === 6 ? 1.12 : dow === 1 ? 0.95 : 1;
    const seasonal = month === 10 ? 1.35 : month === 11 ? 1.5 : month === 0 ? 0.82 : month >= 2 && month <= 4 ? 1.08 : 1;
    // A visible recent dip in paid search efficiency (useful for insights).
    const recentDip = i <= 14 ? 0.86 : 1;
    const noise = () => 0.9 + r() * 0.2;
    const f = growth * weekly * seasonal;

    // ---------------- GA4
    const sessions = Math.round(3100 * f * noise());
    const chSessions = splitInt(sessions, CHANNELS.map((c) => c[1] * (c[0] === "Paid Search" ? recentDip : 1)), r);
    const users = Math.round(sessions * 0.78);
    const engaged = chSessions.map((s) => Math.round(s * (0.55 + r() * 0.14)));
    const atc = chSessions.map((s, idx) => Math.round(s * (CHANNELS[idx]![0] === "Email" ? 0.12 : 0.08) * noise()));
    const checkouts = atc.map((a) => Math.round(a * 0.52 * noise()));
    const purchases = checkouts.map((c) => Math.round(c * 0.47 * noise()));
    const keyEvents = purchases.map((p, idx) => p + Math.round(chSessions[idx]! * 0.008));
    const aov = 74 * (0.92 + r() * 0.16) * (month === 10 ? 0.93 : 1);
    const gaRevenue = purchases.map((p) => money(p * aov));
    push("ga4", "sessions", date, sessions);
    push("ga4", "users", date, users);
    push("ga4", "engaged_sessions", date, engaged.reduce((a, b) => a + b, 0));
    push("ga4", "add_to_carts", date, atc.reduce((a, b) => a + b, 0));
    push("ga4", "checkouts", date, checkouts.reduce((a, b) => a + b, 0));
    push("ga4", "ga4_purchases", date, purchases.reduce((a, b) => a + b, 0));
    push("ga4", "key_events", date, keyEvents.reduce((a, b) => a + b, 0));
    push("ga4", "ga4_revenue", date, money(gaRevenue.reduce((a, b) => a + b, 0)), "", "", true);
    CHANNELS.forEach(([ch], idx) => {
      push("ga4", "sessions", date, chSessions[idx]!, "channel", ch);
      push("ga4", "engaged_sessions", date, engaged[idx]!, "channel", ch);
      push("ga4", "add_to_carts", date, atc[idx]!, "channel", ch);
      push("ga4", "checkouts", date, checkouts[idx]!, "channel", ch);
      push("ga4", "ga4_purchases", date, purchases[idx]!, "channel", ch);
      push("ga4", "key_events", date, keyEvents[idx]!, "channel", ch);
      push("ga4", "ga4_revenue", date, gaRevenue[idx]!, "channel", ch, true);
    });
    const devSplit = splitInt(sessions, [0.64, 0.31, 0.05], r);
    ["mobile", "desktop", "tablet"].forEach((dv, idx) => push("ga4", "sessions", date, devSplit[idx]!, "device", dv));
    splitInt(sessions, COUNTRIES.map((c) => c[1]), r).forEach((v, idx) => push("ga4", "sessions", date, v, "country", COUNTRIES[idx]![0]));

    // ---------------- Shopify (store sees more orders than GA4 tracks)
    const orders = Math.round(purchases.reduce((a, b) => a + b, 0) * (1.1 + r() * 0.06));
    const productSales = splitMoney(orders * aov, PRODUCTS.map((p) => p[1]), r);
    const netSales = money(productSales.reduce((a, b) => a + b, 0));
    push("shopify", "store_orders", date, orders);
    push("shopify", "store_net_sales", date, netSales, "", "", true);
    let units = 0, gross = 0, cogs = 0, refunds = 0;
    PRODUCTS.forEach(([name, , price], idx) => {
      const s = productSales[idx]!;
      const u = Math.max(0, Math.round(s / price));
      const g = money(s * 1.08);
      const c = money(u * price * 0.41);
      const rf = money(s * 0.028 * r());
      units += u; gross += g; cogs += c; refunds += rf;
      push("shopify", "store_net_sales", date, s, "product", name, true);
      push("shopify", "store_gross_sales", date, g, "product", name, true);
      push("shopify", "store_units", date, u, "product", name);
      push("shopify", "store_cogs", date, c, "product", name, true);
      push("shopify", "store_refunds", date, rf, "product", name, true);
    });
    push("shopify", "store_units", date, units);
    push("shopify", "store_gross_sales", date, money(gross), "", "", true);
    push("shopify", "store_cogs", date, money(cogs), "", "", true);
    push("shopify", "store_refunds", date, money(refunds), "", "", true);
    const newCustomers = Math.round(orders * (0.55 + r() * 0.08));
    push("shopify", "store_new_customers", date, newCustomers);
    const cOrders = splitInt(orders, COUNTRIES.map((c) => c[1]), r);
    const cSales = splitMoney(netSales, COUNTRIES.map((c) => c[1]), r);
    const cNew = splitInt(newCustomers, COUNTRIES.map((c) => c[1]), r);
    COUNTRIES.forEach(([c], idx) => {
      push("shopify", "store_orders", date, cOrders[idx]!, "country", c);
      push("shopify", "store_net_sales", date, cSales[idx]!, "country", c, true);
      push("shopify", "store_new_customers", date, cNew[idx]!, "country", c);
    });
    const chOrders = splitInt(orders, [0.93, 0.07], r);
    const chSales = splitMoney(netSales, [0.93, 0.07], r);
    ["Online Store", "Shop app"].forEach((ch, idx) => {
      push("shopify", "store_orders", date, chOrders[idx]!, "channel", ch);
      push("shopify", "store_net_sales", date, chSales[idx]!, "channel", ch, true);
    });

    // ---------------- Google Ads
    let spendT = 0, imprT = 0, clicksT = 0, convT = 0, valueT = 0;
    const byAdChannel = new Map<string, number[]>();
    for (const [name, channel, spendBase, roas, cvr] of CAMPAIGNS) {
      const spend = money(spendBase * growth * seasonal * (0.85 + r() * 0.3));
      const cpc = (name.includes("Brand") ? 0.65 : name.includes("Display") ? 0.42 : 1.35) * (0.9 + r() * 0.2);
      const clicks = Math.round(spend / cpc);
      const impressions = Math.round(clicks / ((name.includes("Brand") ? 0.19 : name.includes("Display") ? 0.004 : 0.035) * (0.9 + r() * 0.2)));
      const effectiveRoas = roas * (name === "Search – Generic" ? recentDip * 0.92 : 1) * (0.85 + r() * 0.3);
      const value = money(spend * effectiveRoas);
      // Conversions follow attributed value at the store's AOV; cvr shifts how many clicks convert.
      const conv = Math.round((value / aov) * (0.95 + r() * 0.1) * (0.8 + cvr * 0.1) * 100) / 100;
      spendT += spend; imprT += impressions; clicksT += clicks; convT += conv; valueT += value;
      push("google_ads", "ad_spend", date, spend, "campaign", name, true);
      push("google_ads", "ad_impressions", date, impressions, "campaign", name);
      push("google_ads", "ad_clicks", date, clicks, "campaign", name);
      push("google_ads", "ad_conversions", date, Math.round(conv * 100) / 100, "campaign", name);
      push("google_ads", "ad_conversion_value", date, value, "campaign", name, true);
      const acc = byAdChannel.get(channel) ?? [0, 0, 0, 0, 0];
      [spend, impressions, clicks, conv, value].forEach((v, k) => (acc[k]! += v));
      byAdChannel.set(channel, acc);
    }
    push("google_ads", "ad_spend", date, money(spendT), "", "", true);
    push("google_ads", "ad_impressions", date, imprT);
    push("google_ads", "ad_clicks", date, clicksT);
    push("google_ads", "ad_conversions", date, Math.round(convT * 100) / 100);
    push("google_ads", "ad_conversion_value", date, money(valueT), "", "", true);
    for (const [ch, [s, im, c, cv, v]] of byAdChannel) {
      push("google_ads", "ad_spend", date, money(s!), "channel", ch, true);
      push("google_ads", "ad_impressions", date, im!, "channel", ch);
      push("google_ads", "ad_clicks", date, c!, "channel", ch);
      push("google_ads", "ad_conversions", date, Math.round(cv! * 100) / 100, "channel", ch);
      push("google_ads", "ad_conversion_value", date, money(v!), "channel", ch, true);
    }

    // ---------------- Search Console (≈3 day reporting lag: skip the most recent days)
    if (i > 2) {
      const clicks = Math.round(chSessions[0]! * (0.88 + r() * 0.08));
      const qClicks = splitInt(clicks, QUERIES.map((q) => q[1]), r);
      let impr = 0, posSum = 0;
      QUERIES.forEach(([q, , pos], idx) => {
        const c = qClicks[idx]!;
        const ctr = Math.max(0.004, 0.32 / Math.pow(pos, 1.05)) * (0.85 + r() * 0.3);
        const im = Math.max(c, Math.round(c / ctr));
        const p = pos * (0.92 + r() * 0.16);
        impr += im;
        posSum += p * im;
        push("gsc", "organic_clicks", date, c, "query", q);
        push("gsc", "organic_impressions", date, im, "query", q);
        push("gsc", "organic_position_sum", date, Math.round(p * im * 100) / 100, "query", q);
      });
      push("gsc", "organic_clicks", date, clicks);
      push("gsc", "organic_impressions", date, impr);
      push("gsc", "organic_position_sum", date, Math.round(posSum * 100) / 100);
      const pClicks = splitInt(clicks, PAGES.map((p) => p[1]), r);
      const pImpr = splitInt(impr, PAGES.map((p) => p[1]), r);
      PAGES.forEach(([p], idx) => {
        push("gsc", "organic_clicks", date, pClicks[idx]!, "page", p);
        push("gsc", "organic_impressions", date, pImpr[idx]!, "page", p);
        push("gsc", "organic_position_sum", date, Math.round(pImpr[idx]! * (8 + idx * 1.7) * 100) / 100, "page", p);
      });
    }

    // ---------------- HubSpot (wholesale pipeline + newsletter contacts)
    const contacts = Math.round(42 * growth * weekly * noise());
    const mql = Math.round(contacts * 0.07 * noise() * (i <= 21 ? 0.72 : 1)); // recent decline in qualified leads
    const created = r() < 0.6 ? 1 + Math.round(r()) : 0;
    const won = r() < 0.32 ? 1 : 0;
    const lost = r() < 0.38 ? 1 : 0;
    const wonValue = won ? money(1800 + r() * 2600) : 0;
    push("hubspot", "crm_new_contacts", date, contacts);
    push("hubspot", "crm_qualified_leads", date, mql);
    push("hubspot", "crm_deals_created", date, created);
    push("hubspot", "crm_deals_won", date, won);
    push("hubspot", "crm_deals_lost", date, lost);
    push("hubspot", "crm_won_value", date, wonValue, "", "", true);
    splitInt(contacts, SOURCES.map((s) => s[1]), r).forEach((v, idx) => push("hubspot", "crm_new_contacts", date, v, "source_medium", SOURCES[idx]![0]));
    splitInt(mql, SOURCES.map((s) => s[1]), r).forEach((v, idx) => push("hubspot", "crm_qualified_leads", date, v, "source_medium", SOURCES[idx]![0]));
    for (const [k, v] of [["crm_deals_created", created], ["crm_deals_won", won], ["crm_deals_lost", lost]] as const) push("hubspot", k, date, v, "pipeline", "Wholesale");
    push("hubspot", "crm_won_value", date, wonValue, "pipeline", "Wholesale", true);
    pipelineDeals = Math.max(20, pipelineDeals + created - won - lost);
    pipelineValue = Math.max(40_000, pipelineValue + created * (2300 + r() * 900) - (won + lost) * (2500 + r() * 800));
    const stageDeals = splitInt(pipelineDeals, STAGES.map((s) => s[1]), r);
    const stageValue = splitMoney(pipelineValue, STAGES.map((s) => s[1]), r);
    push("hubspot", "crm_open_deals", date, pipelineDeals);
    push("hubspot", "crm_open_pipeline", date, money(pipelineValue), "", "", true);
    STAGES.forEach(([s], idx) => {
      push("hubspot", "crm_open_deals", date, stageDeals[idx]!, "deal_stage", s);
      push("hubspot", "crm_open_pipeline", date, stageValue[idx]!, "deal_stage", s, true);
    });
    push("hubspot", "crm_open_deals", date, pipelineDeals, "pipeline", "Wholesale");
    push("hubspot", "crm_open_pipeline", date, money(pipelineValue), "pipeline", "Wholesale", true);
  }

  // Bulk insert in chunks via unnest (parameterized).
  for (let i = 0; i < rows.length; i += 5000) {
    const chunk = rows.slice(i, i + 5000);
    await db.query(
      `INSERT INTO metric_facts (workspace_id, business_id, connection_id, asset_id, provider, metric_key, date, dim_key, dim_value, value, currency)
       SELECT $1, $2, c, a, p, m, d::date, dk, dv, v, cur
         FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::numeric[], $11::text[]) AS t(c, a, p, m, d, dk, dv, v, cur)`,
      [workspaceId, businessId, chunk.map((x) => x.conn), chunk.map((x) => x.asset), chunk.map((x) => x.provider), chunk.map((x) => x.metric),
        chunk.map((x) => x.date), chunk.map((x) => x.dimKey), chunk.map((x) => x.dimValue), chunk.map((x) => x.value), chunk.map((x) => x.currency)],
    );
  }

  // Goals and starter dashboards.
  await db.query(
    `INSERT INTO business_goals (workspace_id, business_id, title, metric_key, target_value, period, created_by) VALUES
       ($1, $2, 'Reach monthly store net sales target', 'store_net_sales', 320000, 'month', $3),
       ($1, $2, 'Keep marketing efficiency ratio above 3', 'mer', 3, 'month', $3)`,
    [workspaceId, businessId, userId],
  );
  // Template availability is computed by the same engine the dashboards use.
  await db.query("SELECT set_config('app.user_id', $1, true)", [userId]);
  const business = { id: businessId, timezone, currency, is_demo: true };
  const av = await loadAvailability(db, business);
  const available = availableBaseMetrics(av);
  for (const t of ["executive", "ecommerce", "marketing"] as const) {
    const { spec } = instantiate(TEMPLATES[t].name, TEMPLATES[t].widgets, available, () => randomUUID().slice(0, 8));
    await saveNewDashboard(db, { workspaceId, businessId, userId, spec, note: "Created from template (demo)" });
  }
  await audit(db, { workspaceId, businessId, actorUserId: userId, action: "business.demo_created", targetType: "business", targetId: businessId, metadata: { rows: rows.length } });
  return { businessId, rows: rows.length };
}
