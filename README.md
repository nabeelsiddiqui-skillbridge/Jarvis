# J.A.R.V.I.S. — AI Command Center

A system that manages all your accounts and gives you live updates, plus live, functional dashboards you can edit.

Talk to JARVIS (voice) or type to it:

- **“What did I miss?”** It checks every connected account and briefs you, out loud if you want.
- **“Any new emails or meetings today?”** It reads your Gmail and Calendar.
- **“Build me a dashboard for Stripe and GitHub.”** It creates a new dashboard and deploys live widgets.
- **“Make the revenue chart a line chart and refresh it every 30 seconds.”** It edits the widgets.

The interface is a dark, HUD-style “tech / AI” theme with an animated arc-reactor core. The core shows when JARVIS is listening, thinking or speaking.

## Features

| | |
|---|---|
| 🎙️ **Voice + chat** | Push-to-talk speech recognition and spoken replies (Web Speech API, works best in Chrome or Edge). You can also just type. |
| 🧠 **Claude-powered agent** | JARVIS runs on Claude with tools: `get_updates`, `add_widget`, `update_widget`, `remove_widget`, `create_dashboard` and `rename_dashboard`. With no API key it falls back to a keyword-based offline brain, so you can still try the UI. |
| 📊 **Live, editable dashboards** | Several dashboards, each with its own tab. Widgets refresh themselves. You can drag, resize, rename, switch between stat/line/area/bar/list views, and change the refresh rate. Layouts are saved in your browser. |
| 🔐 **You connect your own accounts from the frontend** | The Accounts panel is where you link each service with your own token or Google sign-in. Credentials stay on the server and are never sent back to the browser. Every integration is read-only. You can try any connector with **demo data** first. |

### Connectors

| Connector | How you connect | Live metrics |
|---|---|---|
| Google (Gmail + Calendar) | Sign in with Google (OAuth, read-only scopes) | unread count, unread inbox, agenda, events today |
| GitHub | Personal access token | open PRs, notifications, stars per repo, activity |
| Slack | Bot token | recent messages, channels |
| Stripe | Restricted API key | balance, recent payments, 7-day revenue |
| Weather | City name (Open-Meteo, no key) | current temp, next 24h, 7-day |
| Crypto Markets | Watchlist (CoinGecko, no key) | price, 24h change, 7-day chart |
| Hacker News | Nothing to configure | top stories, scores |

To add a connector, create a file in `server/src/connectors/` that implements the `Connector` interface (`types.ts`), then register it in `connectors/index.ts`. The UI and JARVIS pick it up automatically.

## Quick start

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY (optional, but that's the real brain)
npm run dev               # server on :8787, web app on http://localhost:5173
```

Open http://localhost:5173, click **Accounts**, connect something (or choose **Demo data**), then talk to JARVIS.

Production build (one server serves both the API and the web app):

```bash
npm run build
npm start                 # http://localhost:8787
```

### Environment

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Turns on the Claude brain. Without it JARVIS runs in offline mode. |
| `JARVIS_MODEL` | Default `claude-opus-5-5` |
| `JARVIS_EFFORT` | `low` (default, keeps voice replies quick), `medium` or `high` |
| `APP_URL` | Where the web app is served. Used for OAuth redirects. Default `http://localhost:5173` |
| `SERVER_URL` | Public URL of the API server, used to build the Google redirect URI. Default `http://localhost:8787` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Turn on “Sign in with Google”. Add `<SERVER_URL>/api/oauth/google/callback` as an authorized redirect URI. |

## Architecture

```
client/  React + Vite + TypeScript
  App.tsx                 shell, top bar, dashboard tabs
  components/ChatPanel    chat log, mic, voice output, arc-reactor Orb
  components/Dashboard    react-grid-layout grid (drag / resize)
  components/WidgetCard   polls /api/data on its own interval; recharts visuals
  components/AccountsPanel connect / disconnect / demo for each connector
  lib/dashboards.ts       dashboard state (localStorage) + applies JARVIS's edit ops
  lib/voice.ts            speech recognition + synthesis hooks

server/  Express + TypeScript
  index.ts                REST API, session cookie, Google OAuth, static hosting
  agent.ts                Claude tool-use loop (+ offline fallback)
  store.ts                per-session connected accounts (in memory)
  connectors/*            one file per service, plus demo data
```

How a chat turn works: the browser sends the conversation and the current dashboard to `POST /api/chat`. The server runs Claude with the tools above against *your* session's accounts. Data tools fetch live updates; dashboard tools return **ops**, and the browser applies them, so new widgets appear right away.

## Before going to production

- Sessions and credentials are kept **in memory**, so restarting the server means reconnecting. Move them to a database with encrypted credentials (and add real user auth) before others use it.
- Put the server behind HTTPS. The session cookie becomes `Secure` automatically when `APP_URL` is `https://…`.
