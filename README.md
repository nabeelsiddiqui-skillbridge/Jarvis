# Business Command AI

An AI business command center. Customers connect their business accounts, organize them into separate businesses, ask questions by voice or text, and build live, editable dashboards — for one business or a whole client portfolio.

- **Workspaces and businesses** with per-business roles (workspace owner, business administrator, analyst, viewer), enforced on the server and by PostgreSQL row-level security.
- **Live connectors**: Shopify, Google Analytics 4, Google Search Console, Google Ads and HubSpot (OAuth, minimum scopes, asset selection, initial import, incremental sync, webhooks, reconciliation). Further connectors are listed as *planned* and never presented as working.
- **Normalized metrics** with definitions, freshness and limitations; store sales, analytics revenue, ad-attributed value and CRM value are kept separate.
- **Editable dashboards** (drag, resize, edit, version history, sharing) and **AI dashboard generation** that only uses metrics the business actually has.
- **Assistant** (text and streaming voice) that answers through tools against the business's own data and cites evidence for every figure.
- **Briefings, insights and automations**: deterministic detection (period changes, anomalies, goal pacing, data health), AI explanations labelled as possibilities, scheduled briefings and reports, alerts and tasks.
- **Approved external actions** (pause/enable Google Ads campaigns, change budgets, move HubSpot deals): live current values, approval bound to the exact change, re-validation before execution, single execution, full attempt history.
- **Billing** (Stripe Checkout and customer portal, 14-day trial, plan limits enforced on the server) and a **platform admin console** (customers, subscriptions, connector health, sync failures, jobs, AI and voice usage, feature flags, configuration status, audit history, and time-limited, audited support access).
- **Labelled demo mode** with separate seeded data — demo figures are never mixed into real businesses.

`docs/STAGES.md` records, stage by stage, what works, how it was verified, what is simulated and what external setup remains.

## Requirements

- Node.js 22.13+ and npm
- PostgreSQL 16+ (Supabase Postgres works; use its direct connection string)

## Quick start

```bash
npm install
cp .env.example .env       # set DATABASE_URL; everything else is optional to start
npm run db:migrate
npm run dev                # API :8787, worker, web app on http://localhost:5173
```

Sign up, create a workspace and a business, then connect a source — or open the labelled demo business to explore first. Any connector whose provider credentials are missing shows exactly which settings an administrator must add; nothing pretends to be connected.

Add your email to `PLATFORM_ADMIN_EMAILS` to see the platform admin console.

## Production

```bash
npm run build
npm start                  # API + built web app on :8787
npm run start:worker       # durable job worker: syncs, webhooks, detection, automations, actions, retention
```

Run at least one worker; the API and worker can scale independently (jobs are claimed with `FOR UPDATE SKIP LOCKED` and de-duplicated). In production the API refuses to start without `DATABASE_URL`, `ENCRYPTION_KEY`, `APP_URL` and `API_URL`. Migrations run automatically on API start (`AUTO_MIGRATE=false` to disable).

## Configuration

All settings are documented in [`.env.example`](.env.example). Secrets are read only on the server; the admin console reports whether each is set without showing values.

| Area | Settings |
|---|---|
| Core | `DATABASE_URL`, `ENCRYPTION_KEY`, `APP_URL`, `API_URL`, `TRUST_PROXY`, `ALLOW_SIGNUP`, `PLATFORM_ADMIN_EMAILS` |
| AI assistant | `ANTHROPIC_API_KEY`, `ASSISTANT_MODEL`, `ASSISTANT_EFFORT`, `ASSISTANT_DAILY_MESSAGES` |
| Voice | `DEEPGRAM_API_KEY` (optional; browser speech is the fallback), `VOICE_*` |
| Shopify | `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` |
| Google (GA4, Search Console, Ads) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN` |
| HubSpot | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_ENABLE_ACTIONS` |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_AGENCY` |
| Email | `SMTP_URL`, `EMAIL_FROM` |

OAuth redirect URIs and webhook URLs to register with each provider are listed in the admin console under **Configuration** (they are built from `API_URL`).

## Repository layout

```
packages/shared   Types, zod schemas, permissions, metric catalog, plans — used by API and web
apps/server       Express API and worker
  src/auth          sessions, access helpers (inBusiness / inWorkspace), platform admins
  src/connectors    provider adapters (Shopify, Google, HubSpot), sync framework, actions
  src/metrics       metric engine, evidence
  src/assistant     Claude tool loop and tools
  src/insights      deterministic detection, AI explanations
  src/automations   schedules and runs
  src/actions       proposal / approval / execution engine
  src/billing       plans, entitlements, Stripe client and webhook verification
  src/routes        HTTP API (incl. admin)
  src/jobs          Postgres-backed job queue, handlers, scheduler
apps/web          React 19 + Vite + Tailwind app and marketing site
db/migrations     SQL migrations (schema, RLS policies, grants)
docs/STAGES.md    Stage reports
```

Frontend presentation, provider adapters, metric queries, AI orchestration and external action execution are separate modules.

## Security model (summary)

- Every user request runs in a transaction as the restricted `bca_app` role with row-level security; the business ID in a URL is only a lookup key.
- Provider tokens are encrypted at rest (AES-256-GCM) and never reach the browser; OAuth state and webhook signatures (Shopify, HubSpot, Stripe) are verified.
- External actions need an administrator's approval bound to the payload's hash, are re-validated before execution, and run once (idempotency key, row lock, status check after ambiguous failures).
- Platform staff see operational metadata only. Customer data requires a reasoned, time-limited, read-only support grant; owners are notified, can end it, and every request is recorded in their audit log.
- Configurable data retention purges imported records, conversations and job history; aggregated metrics for purged days are kept and frozen.

## Tests

```bash
npm test                   # needs a local PostgreSQL; TEST_DATABASE_URL defaults to postgres://postgres@localhost:5432/bca_test
npm run typecheck
```

The server suite runs against real PostgreSQL (with RLS) and local stand-ins for Shopify, Google, HubSpot, Stripe, Anthropic and Deepgram, covering imports that reconcile with the source, retries and duplicate events, isolation between businesses, the assistant's evidence, approvals and single execution, billing webhooks, plan limits, feature flags and support access.
