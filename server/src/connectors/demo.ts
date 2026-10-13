import type { WidgetData } from "./types.js";

/**
 * Realistic-looking sample data so every connector can be tried before the user
 * hands over real credentials. Values wobble on each call so dashboards feel live.
 */
const wobble = (base: number, pct = 0.08) => Math.round(base * (1 + (Math.random() - 0.5) * pct * 2) * 100) / 100;
const series = (labels: string[], base: number, pct = 0.25) => labels.map((label) => ({ label, value: Math.round(wobble(base, pct)) }));
const weekdays = () =>
  Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (6 - i) * 86400_000).toLocaleDateString("en", { weekday: "short" }));
const hours = () => Array.from({ length: 24 }, (_, i) => `${String((new Date().getHours() + i) % 24).padStart(2, "0")}:00`);

const DEMO: Record<string, { updates: string; metrics: Record<string, () => WidgetData> }> = {
  github: {
    updates: `Signed in as demo-user (demo data).
3 open pull request(s) authored.
- PR: Add voice wake word (jarvis-core), updated 2h ago
- PR: Fix dashboard resize jitter (jarvis-ui), updated 5h ago
- PR: Bump dependencies (infra), updated 1d ago
4 unread notification(s).
- PullRequest: Add voice wake word in acme/jarvis-core (review_requested)
- Issue: Crash on Safari 17 in acme/jarvis-ui (mention)
- Release: v2.4.0 published in acme/infra (subscribed)
- CheckSuite: CI failed on main in acme/jarvis-core (ci_activity)`,
    metrics: {
      open_prs: () => ({ kind: "list", items: [
        { title: "Add voice wake word", subtitle: "acme/jarvis-core", time: "2h ago" },
        { title: "Fix dashboard resize jitter", subtitle: "acme/jarvis-ui", time: "5h ago" },
        { title: "Bump dependencies", subtitle: "acme/infra", time: "1d ago" },
      ] }),
      notifications: () => ({ kind: "list", items: [
        { title: "Add voice wake word", subtitle: "acme/jarvis-core · review_requested", time: "12m ago" },
        { title: "Crash on Safari 17", subtitle: "acme/jarvis-ui · mention", time: "1h ago" },
        { title: "v2.4.0", subtitle: "acme/infra · subscribed", time: "3h ago" },
        { title: "CI failed on main", subtitle: "acme/jarvis-core · ci_activity", time: "4h ago" },
      ] }),
      repo_stars: () => ({ kind: "series", points: [
        { label: "jarvis-core", value: Math.round(wobble(1420, 0.01)) },
        { label: "jarvis-ui", value: Math.round(wobble(860, 0.01)) },
        { label: "holo-grid", value: 412 }, { label: "infra", value: 97 }, { label: "dotfiles", value: 31 },
      ] }),
      activity: () => ({ kind: "list", items: [
        { title: "Push", subtitle: "acme/jarvis-core", time: "8m ago" },
        { title: "PullRequestReview", subtitle: "acme/jarvis-ui", time: "40m ago" },
        { title: "IssueComment", subtitle: "acme/infra", time: "2h ago" },
      ] }),
    },
  },
  google: {
    updates: `7 unread email(s) in the inbox (demo data).
- From Pepper Potts: "Board meeting moved to 3pm" (20m ago)
- From AWS Billing: "Your October invoice is available" (2h ago)
- From Happy Hogan: "Car is ready downstairs" (3h ago)
Upcoming calendar events:
- Stand-up at 10:00
- Board meeting at 15:00 (Conference room 4)
- Dinner with Rhodey at 19:30`,
    metrics: {
      unread: () => ({ kind: "stat", value: 7, label: "unread in inbox" }),
      inbox: () => ({ kind: "list", items: [
        { title: "Board meeting moved to 3pm", subtitle: "Pepper Potts", time: "20m ago" },
        { title: "Your October invoice is available", subtitle: "AWS Billing", time: "2h ago" },
        { title: "Car is ready downstairs", subtitle: "Happy Hogan", time: "3h ago" },
      ] }),
      agenda: () => ({ kind: "list", items: [
        { title: "Stand-up", time: "10:00" },
        { title: "Board meeting", subtitle: "Conference room 4", time: "15:00" },
        { title: "Dinner with Rhodey", time: "19:30" },
      ] }),
      events_today: () => ({ kind: "stat", value: 3, label: "events today" }),
    },
  },
  slack: {
    updates: `Member of 5 channel(s) (demo data).
- #engineering (5m ago): Deploy to prod finished, all green ✅
- #general (30m ago): Lunch is on the 12th floor today
- #incidents (1h ago): Latency spike resolved, postmortem tomorrow`,
    metrics: {
      recent: () => ({ kind: "list", items: [
        { title: "Deploy to prod finished, all green ✅", subtitle: "#engineering", time: "5m ago" },
        { title: "Lunch is on the 12th floor today", subtitle: "#general", time: "30m ago" },
        { title: "Latency spike resolved, postmortem tomorrow", subtitle: "#incidents", time: "1h ago" },
      ] }),
      channels: () => ({ kind: "stat", value: 5, label: "channels" }),
    },
  },
  stripe: {
    updates: `Available balance: $12,480.55 (demo data).
- $249.00 succeeded from tony@starkindustries.com (14m ago)
- $49.00 succeeded from bruce@wayne.co (1h ago)
- $1,200.00 failed from natasha@shield.gov (3h ago)`,
    metrics: {
      balance: () => ({ kind: "stat", value: `$${wobble(12480, 0.02).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, label: "available", delta: 4.2 }),
      payments: () => ({ kind: "list", items: [
        { title: "$249.00", subtitle: "succeeded · tony@starkindustries.com", time: "14m ago" },
        { title: "$49.00", subtitle: "succeeded · bruce@wayne.co", time: "1h ago" },
        { title: "$1,200.00", subtitle: "failed · natasha@shield.gov", time: "3h ago" },
      ] }),
      revenue_7d: () => ({ kind: "series", unit: "$", points: series(weekdays(), 1800, 0.4) }),
    },
  },
};

// Public-data connectors get demo data too, for offline use.
DEMO.weather = {
  updates: "Weather (demo data): 18°C, partly cloudy, wind 12 km/h. Today high 21°C, low 12°C.",
  metrics: {
    current_temp: () => ({ kind: "stat", value: Math.round(wobble(18, 0.05)), unit: "°C", label: "Demo City · partly cloudy" }),
    hourly: () => ({ kind: "series", unit: "°C", points: hours().map((label, i) => ({ label, value: Math.round(14 + 6 * Math.sin((i / 24) * Math.PI * 2)) })) }),
    week: () => ({ kind: "series", unit: "°C", points: series(weekdays(), 20, 0.2) }),
  },
};
DEMO.crypto = {
  updates: "bitcoin: $67,000 (+1.2% 24h)\nethereum: $3,400 (-0.6% 24h)\nsolana: $160 (+3.1% 24h) (demo data)",
  metrics: {
    lead_price: () => ({ kind: "stat", value: `$${wobble(67000, 0.01).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, label: "bitcoin", delta: 1.2 }),
    watchlist: () => ({ kind: "series", unit: "%", points: [
      { label: "bitcoin", value: wobble(1.2, 0.5) }, { label: "ethereum", value: wobble(-0.6, 0.5) }, { label: "solana", value: wobble(3.1, 0.5) },
    ] }),
    lead_7d: () => ({ kind: "series", unit: "$", points: series(weekdays(), 66000, 0.05) }),
  },
};
DEMO.hackernews = {
  updates: "1. Show HN: I built JARVIS for my inbox (512 points)\n2. The unreasonable effectiveness of dashboards (301 points) (demo data)",
  metrics: {
    top: () => ({ kind: "list", items: [
      { title: "Show HN: I built JARVIS for my inbox", subtitle: "512 pts · 210 comments", time: "3h ago" },
      { title: "The unreasonable effectiveness of dashboards", subtitle: "301 pts · 98 comments", time: "5h ago" },
    ] }),
    top_scores: () => ({ kind: "series", points: [{ label: "JARVIS for inbox", value: 512 }, { label: "Dashboards", value: 301 }] }),
  },
};

export function demoUpdates(provider: string): string {
  return DEMO[provider]?.updates ?? "No demo data available.";
}

export function demoMetric(provider: string, metric: string): WidgetData {
  const fn = DEMO[provider]?.metrics[metric];
  if (!fn) throw new Error(`No demo data for ${provider}/${metric}`);
  return fn();
}
