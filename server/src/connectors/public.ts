import { Connector, Credentials, getJson, relTime } from "./types.js";

const coins = (creds: Credentials) =>
  (creds.coins?.trim() || "bitcoin,ethereum,solana")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);

const usd = (n: number) => (n >= 1 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toPrecision(3));

export const crypto: Connector = {
  id: "crypto",
  name: "Crypto Markets",
  category: "Finance",
  description: "Live prices and 7-day charts for your watchlist (CoinGecko).",
  auth: "none",
  fields: [{ key: "coins", label: "Watchlist (CoinGecko ids)", placeholder: "bitcoin,ethereum,solana" }],
  metrics: [
    { id: "lead_price", label: "Price of first coin", viz: ["stat"] },
    { id: "watchlist", label: "Watchlist 24h change %", viz: ["bar", "list"] },
    { id: "lead_7d", label: "First coin 7-day price", viz: ["area", "line"] },
  ],
  async updates(creds) {
    const ids = coins(creds);
    const data = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`);
    return ids
      .filter((id) => data[id])
      .map((id) => `${id}: $${usd(data[id].usd)} (${data[id].usd_24h_change >= 0 ? "+" : ""}${data[id].usd_24h_change.toFixed(2)}% 24h)`)
      .join("\n");
  },
  async fetchMetric(metric, creds) {
    const ids = coins(creds);
    if (metric === "lead_7d") {
      const data = await getJson(`https://api.coingecko.com/api/v3/coins/${ids[0]}/market_chart?vs_currency=usd&days=7&interval=daily`);
      return {
        kind: "series",
        unit: "$",
        points: data.prices.map(([t, v]: [number, number]) => ({
          label: new Date(t).toLocaleDateString("en", { month: "short", day: "numeric" }),
          value: Math.round(v * 100) / 100,
        })),
      };
    }
    const data = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`);
    if (metric === "lead_price") {
      const c = data[ids[0]];
      if (!c) throw new Error(`Unknown coin ${ids[0]}`);
      return { kind: "stat", value: `$${usd(c.usd)}`, label: ids[0], delta: Math.round(c.usd_24h_change * 100) / 100 };
    }
    if (metric === "watchlist") {
      return {
        kind: "series",
        unit: "%",
        points: ids.filter((id) => data[id]).map((id) => ({ label: id, value: Math.round(data[id].usd_24h_change * 100) / 100 })),
      };
    }
    throw new Error(`Unknown crypto metric ${metric}`);
  },
};

async function topStories(n: number) {
  const ids: number[] = await getJson("https://hacker-news.firebaseio.com/v0/topstories.json");
  return Promise.all(ids.slice(0, n).map((id) => getJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)));
}

export const hackernews: Connector = {
  id: "hackernews",
  name: "Hacker News",
  category: "News",
  description: "Top tech stories right now.",
  auth: "none",
  fields: [],
  metrics: [
    { id: "top", label: "Top stories", viz: ["list"] },
    { id: "top_scores", label: "Top story scores", viz: ["bar"] },
  ],
  async updates() {
    const stories = await topStories(8);
    return stories.map((s, i) => `${i + 1}. ${s.title} (${s.score} points)`).join("\n");
  },
  async fetchMetric(metric) {
    const stories = await topStories(metric === "top" ? 15 : 8);
    if (metric === "top_scores") {
      return { kind: "series", points: stories.map((s) => ({ label: s.title.slice(0, 18), value: s.score })) };
    }
    return {
      kind: "list",
      items: stories.map((s) => ({
        title: s.title,
        subtitle: `${s.score} pts · ${s.descendants ?? 0} comments`,
        url: s.url ?? `https://news.ycombinator.com/item?id=${s.id}`,
        time: relTime(s.time * 1000),
      })),
    };
  },
};
