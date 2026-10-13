import { Connector, Credentials, getJson, relTime } from "./types.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "openid",
  "email",
];

export const googleConfigured = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export const googleRedirectUri = () =>
  `${process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`}/api/oauth/google/callback`;

export function googleAuthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      ...body,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token exchange failed: ${data.error_description ?? data.error}`);
  return data as { access_token: string; refresh_token?: string; expires_in: number };
}

export async function exchangeGoogleCode(code: string): Promise<Credentials> {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: googleRedirectUri() });
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? "",
    expires_at: String(Date.now() + t.expires_in * 1000),
  };
}

/** Refreshes the access token in place (creds is the stored object, so the new token sticks). */
async function fresh(creds: Credentials) {
  if (Number(creds.expires_at) - 60_000 > Date.now() || !creds.refresh_token) return creds;
  const t = await tokenRequest({ refresh_token: creds.refresh_token, grant_type: "refresh_token" });
  creds.access_token = t.access_token;
  creds.expires_at = String(Date.now() + t.expires_in * 1000);
  return creds;
}

const gapi = async (url: string, creds: Credentials) =>
  getJson(url, { headers: { Authorization: `Bearer ${(await fresh(creds)).access_token}` } });

async function unreadMail(creds: Credentials, max: number) {
  const [label, list] = await Promise.all([
    gapi("https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX", creds),
    gapi(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent("is:unread in:inbox")}&maxResults=${max}`, creds),
  ]);
  const messages = await Promise.all(
    (list.messages ?? []).map((m: any) =>
      gapi(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, creds),
    ),
  );
  return {
    unread: label.messagesUnread as number,
    messages: messages.map((m: any) => {
      const h = (n: string) => m.payload.headers.find((x: any) => x.name === n)?.value ?? "";
      return { subject: h("Subject") || "(no subject)", from: h("From").replace(/<.*>/, "").trim(), at: Number(m.internalDate), snippet: m.snippet as string };
    }),
  };
}

async function upcomingEvents(creds: Credentials, max: number) {
  const params = new URLSearchParams({ timeMin: new Date().toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: String(max) });
  const data = await gapi(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, creds);
  return (data.items ?? []).map((e: any) => ({
    title: e.summary ?? "(untitled)",
    start: e.start?.dateTime ?? e.start?.date,
    location: e.location as string | undefined,
  }));
}

export const google: Connector = {
  id: "google",
  name: "Google (Gmail + Calendar)",
  category: "Communication",
  description: "Unread email and upcoming calendar events. Read-only.",
  auth: "oauth",
  fields: [],
  metrics: [
    { id: "unread", label: "Unread emails", viz: ["stat"] },
    { id: "inbox", label: "Unread inbox", viz: ["list"] },
    { id: "agenda", label: "Upcoming events", viz: ["list"] },
    { id: "events_today", label: "Events today", viz: ["stat"] },
  ],
  async updates(creds) {
    const [mail, events] = await Promise.all([unreadMail(creds, 8), upcomingEvents(creds, 6)]);
    return [
      `${mail.unread} unread email(s) in the inbox.`,
      ...mail.messages.map((m) => `- From ${m.from}: "${m.subject}" (${relTime(m.at)}) — ${m.snippet.slice(0, 100)}`),
      `Upcoming calendar events:`,
      ...events.map((e: any) => `- ${e.title} at ${new Date(e.start).toLocaleString()}${e.location ? ` (${e.location})` : ""}`),
    ].join("\n");
  },
  async fetchMetric(metric, creds) {
    if (metric === "unread") {
      const mail = await unreadMail(creds, 1);
      return { kind: "stat", value: mail.unread, label: "unread in inbox" };
    }
    if (metric === "inbox") {
      const mail = await unreadMail(creds, 15);
      return { kind: "list", items: mail.messages.map((m) => ({ title: m.subject, subtitle: m.from, time: relTime(m.at) })) };
    }
    const events = await upcomingEvents(creds, 20);
    if (metric === "events_today") {
      const today = new Date().toDateString();
      return { kind: "stat", value: events.filter((e: any) => new Date(e.start).toDateString() === today).length, label: "events today" };
    }
    if (metric === "agenda") {
      return { kind: "list", items: events.map((e: any) => ({ title: e.title, subtitle: e.location, time: new Date(e.start).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" }) })) };
    }
    throw new Error(`Unknown Google metric ${metric}`);
  },
};
