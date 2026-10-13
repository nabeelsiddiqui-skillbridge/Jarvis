# Build stages

Status of each stage of the build plan: what works, what is simulated, and what external setup remains.

## Stage 1 — Authentication, businesses, permissions, design system ✅

**Works**
- Email/password accounts (scrypt), database sessions (only token hashes stored), HttpOnly SameSite cookies, CSRF header check, rate-limited auth endpoints, password change (signs out other devices), account deletion.
- Workspaces, workspace memberships (owner/member), invitations by one-time link (bound to the invited email, 7-day expiry, revocable).
- Multiple businesses per workspace with name, logo, industry, website, timezone, reporting currency, description; user-confirmed goals.
- Business-level roles: workspace owner (implicit on all businesses), business administrator, analyst, viewer. One shared permission matrix (`packages/shared/src/permissions.ts`) used by the API for enforcement and the UI for affordances.
- Server-enforced access on every business route (membership resolved in the database for the signed-in user; inaccessible and non-existent businesses both return 404) **plus PostgreSQL row-level security** — the API runs each request as the restricted `bca_app` role with the user id set.
- Audit log of security-relevant actions, visible to business administrators.
- Persistent business switcher (search, recent selections, create), active business shown in the top bar, business-keyed queries and remounted pages so nothing carries over on a switch.
- App shell: left navigation, top context bar, collapsible assistant panel (desktop), drawer + bottom tab bar (mobile), skip link, visible focus, reduced-motion support.
- Onboarding: account → workspace → first business → goals.

**Simulated / not yet built**
- Nothing is simulated. Pages for later stages show a clear "delivered in stage N" notice instead of fake content.
- Invitation emails: links are shown to the owner to copy until an email provider is configured (Stage 7).

**Verified**
- `apps/server/test/access.test.ts`: cross-user and cross-business isolation through the API, role enforcement (viewer/analyst/owner), invitation binding, and RLS blocking raw SQL reads/writes across tenants and access to credential tables.
- Browser walkthrough (desktop + 390px mobile): sign-up, onboarding, creating/switching businesses with no data carry-over, settings, invitations.

**External setup**: PostgreSQL 16+ (`DATABASE_URL`), `ENCRYPTION_KEY` in production.

## Stage 2 — Persisted editable dashboards with labelled demo data ✅

**Works**
- **Metric definitions** (`packages/shared/src/metrics.ts`): 40+ metrics with formulas, units, allowed breakdowns, source precedence and value families. Store sales, GA4-observed revenue, ad-attributed revenue and CRM won/pipeline value are separate families and are never added together. Ratios (AOV, CTR, ROAS, MER, conversion and win rates, average position) are computed from aggregated numerators and denominators. Gross profit/margin appear only when COGS exists. Snapshot metrics (open pipeline) use the period-end value.
- **Normalized facts** (`metric_facts`) keep provider, connection, asset, reporting date, dimension, currency and ingestion time. Connectors write explicit daily totals, so a missing day is "no data", never zero.
- **Query engine** (`apps/server/src/metrics/engine.ts`): validated declarative widget queries (metric, extra metrics, dimension, granularity, date range, comparison, filters, source restriction, limit/sort). It returns totals, series, breakdowns and funnel steps, plus availability (available / partial / unavailable with reason), sources, freshness, staleness, limitations and the formula. Mixed currencies are refused rather than converted. Parameterized SQL only, run under row-level security.
- **Calculated metrics**: a safe arithmetic language over metric references, parsed into a tree and evaluated on aggregates. No code is executed.
- **Dashboards**: stored in the database (widgets, layout, date range), with drag/resize, add/edit/duplicate/remove/rename, and 13 widget types (KPI, line, area, bar, donut, table, funnel, ranking, pipeline, goal progress, geographic, AI commentary, data freshness). Also date filters, comparisons, targets, calculated metrics, templates that include only widgets with available data, autosave with optimistic concurrency (409 on conflicting edits), undo/redo, version history with restore, duplicate, and sharing (business-wide or restricted to named members who already have business access; edit rights only for analysts and up).
- **Live refresh**: Postgres `NOTIFY` → server-sent events per business → widgets for that business refetch. Wired for syncs in Stage 3.
- **Command Center**: KPIs chosen by industry and available data, revenue and acquisition trends, a sales/pipeline view, goal progress with pacing, connection health, suggested questions and recent activity. Loading, empty, partial, stale, unavailable/reconnect and error states.
- **Demo mode**: "Explore a demo business" creates a separate, clearly labelled business ("Aurora Outfitters (Demo)") with about 13 months of seeded data from five simulated sources. A database trigger makes it impossible to attach demo connections to a real business, or real ones to a demo business. Demo data is labelled in the top bar, a page banner and every widget footer.

**Simulated**
- The demo business's data is generated sample data (by design and labelled). No real business ever shows simulated values.
- AI commentary widgets and the daily briefing show a clear "arrives in stage 5/7" notice instead of text.

**Verified** (`apps/server/test/dashboards.test.ts`, `packages/shared/test/shared.test.ts`)
- Engine totals reconcile with direct SQL sums of stored facts; breakdowns sum to totals; AOV equals sum(sales) ÷ sum(orders); MER equals sales ÷ spend; calculated metrics match hand computation.
- Missing data is `unavailable` (never 0); partial coverage is flagged with exact missing-day counts and nulls in series.
- Invalid queries (unknown metric, impossible breakdown, injection attempts) are rejected.
- Dashboard edits persist, stale saves get a 409, versions list and restore correctly, private dashboards are invisible without a share, viewers can't edit, and nothing is reachable across businesses.
- A browser walkthrough of demo creation, Command Center, dashboard editing (add widget with target, remove, undo, reload) and version history found no console errors. The 390px mobile layout has no horizontal overflow.

**External setup**: none beyond Stage 1.
