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
