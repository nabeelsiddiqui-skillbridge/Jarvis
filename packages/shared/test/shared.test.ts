import { describe, expect, it } from "vitest";
import { CalcError, evalCalc, parseCalc } from "../src/calc";
import { previousPeriod, resolvePreset, todayIn, bucketOf } from "../src/dates";
import { baseDependencies, METRICS, getMetric, formulaInputs } from "../src/metrics";
import { widgetSpec } from "../src/widgets";
import { TEMPLATES, instantiate } from "../src/templates";

describe("metric registry", () => {
  it("every derived metric resolves to known base metrics", () => {
    for (const m of METRICS) {
      if (m.kind !== "derived") continue;
      for (const input of formulaInputs(m.formula)) expect(getMetric(input), `${m.key} → ${input}`).toBeTruthy();
      expect(baseDependencies(m.key).length).toBeGreaterThan(0);
    }
  });
  it("keeps revenue families separate", () => {
    expect(getMetric("store_net_sales")!.family).toBe("store_sales");
    expect(getMetric("ad_conversion_value")!.family).toBe("ad_attributed");
    expect(getMetric("ga4_revenue")!.family).toBe("analytics_revenue");
    expect(getMetric("crm_won_value")!.family).toBe("crm_won");
  });
  it("profit requires cost of goods", () => {
    expect(baseDependencies("gross_profit").sort()).toEqual(["store_cogs", "store_net_sales"]);
    expect(baseDependencies("win_rate").sort()).toEqual(["crm_deals_lost", "crm_deals_won"]);
  });
});

describe("dates", () => {
  it("resolves presets ending yesterday and computes previous periods", () => {
    expect(resolvePreset("last_7_days", "2026-10-13")).toEqual({ from: "2026-10-06", to: "2026-10-12" });
    expect(resolvePreset("last_month", "2026-03-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(resolvePreset("quarter_to_date", "2026-11-05")).toEqual({ from: "2026-10-01", to: "2026-11-05" });
    expect(previousPeriod({ from: "2026-10-06", to: "2026-10-12" })).toEqual({ from: "2026-09-29", to: "2026-10-05" });
  });
  it("uses the business timezone for today", () => {
    const t = new Date("2026-10-13T02:00:00Z");
    expect(todayIn("UTC", t)).toBe("2026-10-13");
    expect(todayIn("America/Los_Angeles", t)).toBe("2026-10-12");
    expect(todayIn("Asia/Karachi", t)).toBe("2026-10-13");
  });
  it("buckets by ISO week and month", () => {
    expect(bucketOf("2026-10-15", "week")).toBe("2026-10-12");
    expect(bucketOf("2026-10-15", "month")).toBe("2026-10-01");
  });
});

describe("calculated metrics", () => {
  it("parses and evaluates safely", () => {
    const n = parseCalc("({store_net_sales} - {store_cogs}) / {store_orders}");
    expect(evalCalc(n, { store_net_sales: 1000, store_cogs: 400, store_orders: 10 })).toBe(60);
    expect(evalCalc(n, { store_net_sales: 1000, store_cogs: null, store_orders: 10 })).toBeNull();
    expect(evalCalc(parseCalc("{store_net_sales} / {ad_spend}"), { store_net_sales: 5, ad_spend: 0 })).toBeNull();
  });
  it("rejects anything that isn't arithmetic over known metrics", () => {
    for (const bad of ["alert(1)", "{unknown}", "{store_orders} +", "process.exit()", "1 + 2", "{a}}"]) {
      expect(() => parseCalc(bad), bad).toThrow(CalcError);
    }
  });
});

describe("widget validation", () => {
  const layout = { x: 0, y: 0, w: 3, h: 4 };
  it("rejects unknown metrics and impossible breakdowns", () => {
    expect(widgetSpec.safeParse({ id: "a", type: "kpi", title: "x", query: { metric: "made_up" }, layout }).success).toBe(false);
    expect(widgetSpec.safeParse({ id: "a", type: "bar", title: "x", query: { metric: "sessions", dimension: "deal_stage" }, layout }).success).toBe(false);
    expect(widgetSpec.safeParse({ id: "a", type: "donut", title: "x", query: { metric: "sessions" }, layout }).success).toBe(false);
    expect(widgetSpec.safeParse({ id: "a", type: "bar", title: "x", query: { metric: "sessions", dimension: "channel" }, layout }).success).toBe(true);
  });
});

describe("templates", () => {
  it("drop widgets whose data isn't available and report why", () => {
    let n = 0;
    const { spec, omitted } = instantiate("Shop", TEMPLATES.ecommerce.widgets, new Set(["store_net_sales", "store_orders", "store_new_customers"]), () => `w${n++}`);
    const titles = spec.widgets.map((w) => w.title);
    expect(titles).toContain("Average order value");
    expect(titles).not.toContain("Marketing efficiency ratio");
    expect(omitted.find((o) => o.title === "Marketing efficiency ratio")?.missing).toEqual(["ad_spend"]);
  });
});
