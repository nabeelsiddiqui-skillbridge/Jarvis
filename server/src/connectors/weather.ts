import { Connector, Credentials, getJson } from "./types.js";

const CODES: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "rain showers", 82: "violent showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail",
};

async function locate(creds: Credentials) {
  const city = creds.city?.trim() || "London";
  const geo = await getJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`);
  const hit = geo.results?.[0];
  if (!hit) throw new Error(`Could not find a city called "${city}"`);
  return { name: `${hit.name}${hit.country ? `, ${hit.country}` : ""}`, lat: hit.latitude, lon: hit.longitude };
}

async function forecast(creds: Credentials) {
  const loc = await locate(creds);
  const data = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
      `&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m` +
      `&hourly=temperature_2m&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=7&timezone=auto`,
  );
  return { loc, data };
}

export const weather: Connector = {
  id: "weather",
  name: "Weather",
  category: "Lifestyle",
  description: "Live conditions and 7-day forecast (Open-Meteo, no key needed).",
  auth: "none",
  fields: [{ key: "city", label: "City", placeholder: "London" }],
  metrics: [
    { id: "current_temp", label: "Current temperature", viz: ["stat"] },
    { id: "hourly", label: "Next 24h temperature", viz: ["area", "line", "bar"] },
    { id: "week", label: "7-day highs", viz: ["bar", "line", "list"] },
  ],
  async verify(creds) {
    await locate(creds);
  },
  async updates(creds) {
    const { loc, data } = await forecast(creds);
    const c = data.current;
    const d = data.daily;
    return [
      `Weather in ${loc.name}: ${c.temperature_2m}°C, ${CODES[c.weather_code] ?? "unknown conditions"}, wind ${c.wind_speed_10m} km/h, humidity ${c.relative_humidity_2m}%.`,
      `Today: high ${d.temperature_2m_max[0]}°C, low ${d.temperature_2m_min[0]}°C. Tomorrow: ${CODES[d.weather_code[1]] ?? ""}, high ${d.temperature_2m_max[1]}°C.`,
    ].join("\n");
  },
  async fetchMetric(metric, creds) {
    const { loc, data } = await forecast(creds);
    if (metric === "current_temp") {
      return { kind: "stat", value: Math.round(data.current.temperature_2m), unit: "°C", label: `${loc.name} · ${CODES[data.current.weather_code] ?? ""}` };
    }
    if (metric === "hourly") {
      const now = Date.now();
      const idx = Math.max(0, data.hourly.time.findIndex((t: string) => new Date(t).getTime() >= now - 3600_000));
      return {
        kind: "series",
        unit: "°C",
        points: data.hourly.time.slice(idx, idx + 24).map((t: string, i: number) => ({
          label: t.slice(11, 16),
          value: data.hourly.temperature_2m[idx + i],
        })),
      };
    }
    if (metric === "week") {
      return {
        kind: "series",
        unit: "°C",
        points: data.daily.time.map((t: string, i: number) => ({
          label: new Date(t).toLocaleDateString("en", { weekday: "short" }),
          value: data.daily.temperature_2m_max[i],
        })),
      };
    }
    throw new Error(`Unknown weather metric ${metric}`);
  },
};
