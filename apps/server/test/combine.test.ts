import { addDays, todayIn } from "@bca/shared";
import { beforeAll, describe, expect, it } from "vitest";
import { bootApp, metric } from "./kit.js";
import { signup, workspaceWithBusiness } from "./helpers.js";

/**
 * The engine adds up metrics marked combine:"sum" across distinct platforms, keeps manual
 * sources (CSV/Sheets) as a fallback, aligns the inputs of derived metrics to the platforms
 * that report all of them, and can break figures down by platform.
 */
let pool: any, app: any;
let owner: any, businessId: string, workspaceId: string;
const TZ = "America/New_York";
const to = addDays(todayIn(TZ), -1);
const from = addDays(to, -9);

async function source(provider: string, facts: Record<string, number>, opts: { days?: number; offset?: number } = {}) {
  const c = await pool.query(
    `INSERT INTO connections (workspace_id, business_id, provider, display_name, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [workspaceId, businessId, provider, `${provider} account`],
  );
  const a = await pool.query(
    `INSERT INTO connection_assets (workspace_id, business_id, connection_id, provider_asset_id, name, kind, currency, timezone, selected)
     VALUES ($1, $2, $3, 'acct', $4, 'account', 'USD', $5, true) RETURNING id`,
    [workspaceId, businessId, c.rows[0].id, `${provider} asset`, TZ],
  );
  const days = opts.days ?? 10;
  for (let i = 0; i < days; i++) {
    const date = addDays(to, -i - (opts.offset ?? 0));
    for (const [m, v] of Object.entries(facts)) {
      await pool.query(
        `INSERT INTO metric_facts (workspace_id, business_id, connection_id, asset_id, provider, metric_key, date, dim_key, dim_value, value, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '', '', $8, $9)`,
        [workspaceId, businessId, c.rows[0].id, a.rows[0].id, provider, m, date, v, /spend|value|sales|cogs/.test(m) ? "USD" : null],
      );
    }
  }
}

beforeAll(async () => {
  ({ app, pool } = await bootApp());
  owner = await signup(app, "Owner");
  ({ businessId, workspaceId } = await workspaceWithBusiness(owner, "Combo"));
  await source("google_ads", { ad_spend: 100, ad_clicks: 50, ad_conversion_value: 400 });
  await source("meta_ads", { ad_spend: 60, ad_clicks: 30, ad_conversion_value: 150 }, { days: 4 });
  await source("tiktok_ads", { ad_spend: 40, ad_clicks: 40 });
  await source("csv", { ad_spend: 999, store_net_sales: 1000 });
  await source("shopify", { store_net_sales: 500, store_cogs: 200 });
  await source("woocommerce", { store_net_sales: 300 });
  // Snapshots recorded on different "today"s (accounts in different timezones).
  await source("mailchimp", { email_list_size: 1000 }, { days: 3 });
  await source("brevo", { email_list_size: 250 }, { days: 3, offset: 1 });
});

describe("combining metrics across platforms", () => {
  it("sums ad spend across ad platforms and ignores the CSV fallback", async () => {
    const r = await metric(owner, businessId, { metric: "ad_spend", dateRange: { from, to } });
    expect(r.total).toBe(100 * 10 + 60 * 4 + 40 * 10);
    expect(r.limitations.join(" ")).toMatch(/combines Google Ads, Meta Ads, TikTok Ads/);
    expect(r.limitations.join(" ")).toMatch(/Meta Ads ad spend starts/);
  });

  it("breaks a combined metric down by platform", async () => {
    const r = await metric(owner, businessId, { metric: "ad_spend", dateRange: { from, to }, dimension: "platform" });
    const rows = Object.fromEntries(r.rows.map((x: any) => [x.label, x.value]));
    expect(rows).toEqual({ "Google Ads": 1000, "Meta Ads": 240, "TikTok Ads": 400 });
  });

  it("aligns derived-metric inputs to the platforms reporting all of them", async () => {
    // ROAS: TikTok reports spend but no conversion value, so it's left out of both sides.
    const roas = await metric(owner, businessId, { metric: "roas", dateRange: { from, to } });
    expect(roas.total).toBeCloseTo((400 * 10 + 150 * 4) / (100 * 10 + 60 * 4), 6);
    expect(roas.limitations.join(" ")).toMatch(/uses Google Ads, Meta Ads only; TikTok Ads doesn't report/);
    // Gross profit only where costs exist (Shopify).
    const gp = await metric(owner, businessId, { metric: "gross_profit", dateRange: { from, to } });
    expect(gp.total).toBe((500 - 200) * 10);
    // CPC uses all three.
    const cpc = await metric(owner, businessId, { metric: "cpc", dateRange: { from, to } });
    expect(cpc.total).toBeCloseTo((1000 + 240 + 400) / (500 + 120 + 400), 6);
  });

  it("uses a manual source only when no platform has the metric, and honours source filters", async () => {
    const sales = await metric(owner, businessId, { metric: "store_net_sales", dateRange: { from, to } });
    expect(sales.total).toBe((500 + 300) * 10);
    const csvOnly = await metric(owner, businessId, { metric: "store_net_sales", dateRange: { from, to }, sources: ["csv"] });
    expect(csvOnly.total).toBe(10000);
    const one = await metric(owner, businessId, { metric: "ad_spend", dateRange: { from, to }, sources: ["tiktok_ads"] });
    expect(one.total).toBe(400);
    // MER mixes families (store sales ÷ ad spend): each side combines independently.
    const mer = await metric(owner, businessId, { metric: "mer", dateRange: { from, to } });
    expect(mer.total).toBeCloseTo(8000 / 1640, 6);
  });

  it("adds up each account's latest snapshot, even when they're on different days", async () => {
    const r = await metric(owner, businessId, { metric: "email_list_size", dateRange: { from, to } });
    expect(r.total).toBe(1250);
  });
});
