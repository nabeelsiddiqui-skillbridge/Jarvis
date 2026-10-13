import type pg from "pg";
import { addDays, formatMetricValue, getMetric, thresholdConditions, todayIn, widgetQuery, type AutomationSpec, type InsightSeverity, type MetricUnit } from "@bca/shared";
import { pool } from "../db/pool.js";
import { config } from "../config.js";
import { audit } from "../lib/audit.js";
import { emailConfigured, escapeHtml, sendEmail } from "../lib/mail.js";
import { businessAdmins, notifyUsers, withAccess } from "../lib/notify.js";
import { enqueue } from "../jobs/queue.js";
import { availableBaseMetrics, loadAvailability, loadCalcs, runQuery } from "../metrics/engine.js";
import { toMetricEvidence } from "../metrics/evidence.js";
import { upsertInsights } from "../insights/store.js";
import { buildReport, reportPeriod, saveReport } from "../reports/build.js";
import { nextRunAt } from "./schedule.js";

/**
 * Automations: scheduled or event-triggered rules for one business. Each logical
 * occurrence gets exactly one run (unique automation + dedupe key), executed by a
 * worker job with retries. Under "approval required", the run prepares its
 * actions (notifications, emails, tasks) and holds them until an administrator
 * approves; reports themselves are generated either way.
 */

interface Plan {
  notify?: { userIds: string[]; title: string; body: string; link: string; dedupeKey: string };
  email?: { userIds: string[]; subject: string; text: string; html: string };
  tasks?: { title: string; description: string; assigneeId: string | null; insightId: string | null; dedupeKey: string }[];
}

const link = (businessId: string, path: string) => `/app/b/${businessId}/${path}`;

// ------------------------------------------------------------------ scheduling

export async function scheduleAutomations() {
  const { rows } = await pool.query(`SELECT * FROM automations WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now() ORDER BY next_run_at LIMIT 200`);
  for (const a of rows) {
    const slot = new Date(a.next_run_at).toISOString();
    await createRun(pool, a, `schedule:${slot}`, { scheduledFor: slot });
    const next = nextRunAt(a.trigger, a.timezone, new Date(Math.max(Date.now(), new Date(a.next_run_at).getTime())));
    await pool.query(`UPDATE automations SET next_run_at = $2 WHERE id = $1`, [a.id, next]);
  }
}

/** Create the run for an occurrence (no-op if it already exists) and queue it. */
export async function createRun(db: pg.PoolClient | pg.Pool, a: any, dedupeKey: string, triggerInfo: Record<string, unknown>): Promise<string | null> {
  const { rows } = await db.query(
    `INSERT INTO automation_runs (automation_id, business_id, dedupe_key, trigger_info) VALUES ($1, $2, $3, $4)
     ON CONFLICT (automation_id, dedupe_key) DO NOTHING RETURNING id`,
    [a.id, a.business_id, dedupeKey, JSON.stringify(triggerInfo)],
  );
  if (!rows[0]) return null;
  await enqueue(db, { type: "automation.run", workspaceId: a.workspace_id, businessId: a.business_id, payload: { runId: rows[0].id }, dedupeKey: `autorun:${rows[0].id}`, maxAttempts: 4 });
  return rows[0].id;
}

/** Fire event-triggered automations for a business. */
export async function fireEvent(db: pg.PoolClient, businessId: string, event: "connection_failed" | "insights_detected", info: Record<string, unknown>, eventKey: string) {
  const { rows } = await db.query(`SELECT * FROM automations WHERE business_id = $1 AND enabled AND trigger->>'type' = 'event' AND trigger->>'event' = $2`, [businessId, event]);
  for (const a of rows) await createRun(db, a, `event:${eventKey}`, info);
  return rows.length;
}

// ------------------------------------------------------------------ execution

export async function executeRun(db: pg.PoolClient, runId: string, attempt: number): Promise<{ status: string; summary: string }> {
  const run = (await db.query(`SELECT * FROM automation_runs WHERE id = $1`, [runId])).rows[0];
  if (!run || ["succeeded", "skipped", "awaiting_approval", "rejected"].includes(run.status)) return { status: run?.status ?? "missing", summary: "Already handled" };
  const a = (await db.query(`SELECT * FROM automations WHERE id = $1`, [run.automation_id])).rows[0];
  const business = (await db.query(`SELECT * FROM businesses WHERE id = $1 AND archived_at IS NULL`, [run.business_id])).rows[0];
  if (!a || !business) {
    await finish(db, runId, "skipped", { summary: "The automation or business no longer exists." });
    return { status: "skipped", summary: "removed" };
  }
  await db.query(`UPDATE automation_runs SET status = 'running', attempts = $2, started_at = COALESCE(started_at, now()), error = NULL WHERE id = $1`, [runId, attempt]);

  const recipients = a.actions?.notify?.userIds?.length ? a.actions.notify.userIds : await businessAdmins(db, business.id);
  const out: Record<string, unknown> = {};
  let plan: Plan = {};

  if (a.kind === "daily_briefing" || a.kind === "weekly_report") {
    const { period, label } = reportPeriod(a.kind, a.timezone);
    const built = await buildReport(db, business, a.kind, period, label);
    const reportId = await saveReport(db, business, a.kind, period, built, { runId });
    out.reportId = reportId;
    out.summary = `${a.kind === "daily_briefing" ? "Briefing" : "Report"} for ${period.from === period.to ? period.from : `${period.from} – ${period.to}`} created.`;
    const title = `${a.kind === "daily_briefing" ? "Daily briefing" : "Weekly report"} for ${business.name}`;
    const lines = built.content.deterministicSummary;
    plan = {
      notify: { userIds: recipients, title, body: lines.slice(0, 2).join(" ").replace(/\s*\[R\d+\]/g, ""), link: link(business.id, `reports/${reportId}`), dedupeKey: `run:${runId}` },
      ...(a.actions?.notify?.email ? { email: { userIds: recipients, subject: `${title} · ${period.to}`, text: emailText(built.narrative, lines, `${config.appUrl}${link(business.id, `reports/${reportId}`)}`, business.is_demo), html: emailHtml(title, built.narrative, lines, `${config.appUrl}${link(business.id, `reports/${reportId}`)}`, business.is_demo) } } : {}),
    };
  } else if (a.kind === "threshold_alert") {
    const cond = thresholdConditions.parse(a.conditions);
    const yesterday = addDays(todayIn(a.timezone), -1);
    const range = cond.window === "yesterday" ? { from: yesterday, to: yesterday } : cond.window === "last_7_days" ? { from: addDays(yesterday, -6), to: yesterday } : cond.window === "last_30_days" ? { from: addDays(yesterday, -29), to: yesterday } : { preset: "month_to_date" as const };
    const usesChange = cond.test.startsWith("change");
    const av = await loadAvailability(db, business);
    const missing = !availableBaseMetrics(av).size;
    const query = widgetQuery.parse({ metric: cond.metric, dateRange: range, comparison: usesChange ? "previous_period" : "none", sources: a.scope?.sources ?? [] });
    const r = await runQuery({ db, business, availability: av, calcs: await loadCalcs(db, business.id), dashboardRange: { preset: "last_30_days" } }, query);
    const m = getMetric(cond.metric)!;
    const fmt = (v: number | null) => formatMetricValue(v, m.unit as MetricUnit, r.currency);
    if (missing || r.availability !== "available" || r.total == null || (usesChange && (r.change == null || r.comparisonPartial))) {
      await finish(db, runId, "succeeded", { summary: `Not evaluated: ${r.unavailableReason ?? (r.availability === "partial" ? "the period is only partly covered by data" : "no data for this period")}. No alert sent.` });
      return { status: "succeeded", summary: "not evaluated" };
    }
    const value = usesChange ? r.change! : r.total;
    const met = cond.test === "above" ? value > cond.value : cond.test === "below" ? value < cond.value : cond.test === "change_up_pct" ? value >= cond.value : value <= -cond.value;
    const valueText = usesChange ? `${value >= 0 ? "+" : ""}${value.toFixed(1)}% vs the previous period` : fmt(value);
    if (!met) {
      await finish(db, runId, "succeeded", { summary: `Condition not met: ${m.label} is ${valueText}.` });
      return { status: "succeeded", summary: "not met" };
    }
    const testText = cond.test === "above" ? `above ${fmt(cond.value)}` : cond.test === "below" ? `below ${fmt(cond.value)}` : cond.test === "change_up_pct" ? `up at least ${cond.value}%` : `down at least ${cond.value}%`;
    const severity: InsightSeverity = (cond.test === "above" || cond.test === "change_up_pct") === m.higherIsBetter ? "positive" : "warning";
    const ev = toMetricEvidence("I1", r, query, `${m.label}, ${r.range.from === r.range.to ? r.range.from : `${r.range.from} – ${r.range.to}`}`);
    const { created } = await upsertInsights(db, business, [{
      rule: "threshold", dedupeKey: `threshold:${a.id}:${r.range.from}:${r.range.to}`, severity,
      title: `${a.name}: ${m.label} ${testText}`,
      finding: `${m.label} was ${valueText} for ${r.range.from === r.range.to ? r.range.from : `${r.range.from} to ${r.range.to}`} — the alert condition is "${testText}".`,
      impact: null, nextStep: "Review the evidence and the related dashboard; adjust the threshold if this level is expected.",
      metricKey: cond.metric, period: r.range, comparison: r.comparisonRange, evidence: [ev], drivers: [],
    }], a.id);
    out.insightIds = created;
    out.summary = `Alert: ${m.label} ${testText} (${valueText}).`;
    plan = {
      notify: { userIds: recipients, title: `Alert · ${a.name}`, body: `${m.label} is ${valueText} (${testText}).`, link: link(business.id, "insights"), dedupeKey: `threshold:${a.id}:${r.range.to}` },
      ...(a.actions?.notify?.email ? { email: { userIds: recipients, subject: `Alert: ${m.label} ${testText} — ${business.name}`, text: `${m.label} is ${valueText} (${testText}).\n\n${config.appUrl}${link(business.id, "insights")}`, html: `<p>${escapeHtml(`${m.label} is ${valueText} (${testText}).`)}</p><p><a href="${config.appUrl}${link(business.id, "insights")}">Open insights</a></p>` } } : {}),
      ...(a.actions?.task ? { tasks: [{ title: `Investigate: ${m.label} ${testText}`, description: `Automation "${a.name}" detected ${m.label} at ${valueText}.`, assigneeId: a.actions.task.assigneeId, insightId: created[0] ?? null, dedupeKey: `threshold:${a.id}:${r.range.to}` }] } : {}),
    };
  } else if (a.kind === "connection_alert") {
    const info = run.trigger_info;
    const scope = a.scope ?? {};
    if ((scope.connectionIds?.length && !scope.connectionIds.includes(info.connectionId)) || (scope.sources?.length && !scope.sources.includes(info.provider))) {
      await finish(db, runId, "skipped", { summary: `Outside this automation's scope (${info.name}).` });
      return { status: "skipped", summary: "scope" };
    }
    const what = info.status === "reauth_required" ? "needs to be reconnected" : "failed to sync";
    out.summary = `${info.name} ${what}.`;
    plan = {
      notify: { userIds: recipients, title: `${info.name} ${what}`, body: info.error ?? "", link: link(business.id, "connections"), dedupeKey: `conn:${info.connectionId}:${info.status}:${todayIn(a.timezone)}` },
      ...(a.actions?.notify?.email ? { email: { userIds: recipients, subject: `${info.name} ${what} — ${business.name}`, text: `${info.error ?? ""}\n\nOpen Connections: ${config.appUrl}${link(business.id, "connections")}`, html: `<p>${escapeHtml(info.error ?? "")}</p><p><a href="${config.appUrl}${link(business.id, "connections")}">Open Connections</a></p>` } } : {}),
      ...(a.actions?.task ? { tasks: [{ title: `Fix the ${info.name} connection`, description: info.error ?? "", assigneeId: a.actions.task.assigneeId, insightId: null, dedupeKey: `conn:${info.connectionId}:${info.status}:${todayIn(a.timezone)}` }] } : {}),
    };
  } else if (a.kind === "insight_tasks") {
    const min = a.conditions?.minSeverity === "critical" ? ["critical"] : ["critical", "warning"];
    const ins = (await db.query(`SELECT id, title, finding, next_step, severity FROM insights WHERE id = ANY($1::uuid[]) AND business_id = $2 AND severity = ANY($3::text[])`, [run.trigger_info.insightIds ?? [], business.id, min])).rows;
    if (!ins.length) {
      await finish(db, runId, "skipped", { summary: "No new insights at the chosen severity." });
      return { status: "skipped", summary: "none" };
    }
    out.summary = `${ins.length} task${ins.length > 1 ? "s" : ""} for new insights.`;
    const assignee = a.actions?.task?.assigneeId ?? null;
    plan = {
      tasks: ins.map((i) => ({ title: i.title, description: [i.finding, i.next_step].filter(Boolean).join("\n\nNext step: "), assigneeId: assignee, insightId: i.id, dedupeKey: `insight:${i.id}` })),
      ...(assignee ? { notify: { userIds: [assignee], title: `${ins.length} new task${ins.length > 1 ? "s" : ""} from insights`, body: ins[0].title, link: link(business.id, "insights?tab=tasks"), dedupeKey: `run:${runId}` } } : {}),
    };
  }

  const hasActions = Boolean(plan.notify?.userIds.length || plan.email || plan.tasks?.length);
  if (a.approval_policy === "approval_required" && hasActions) {
    await db.query(`UPDATE automation_runs SET status = 'awaiting_approval', output = $2, pending_actions = $3, finished_at = now() WHERE id = $1`, [runId, JSON.stringify(out), JSON.stringify(plan)]);
    await notifyUsers(db, { workspaceId: business.workspace_id, businessId: business.id, userIds: await businessAdmins(db, business.id), kind: "approval", title: `Approval needed: ${a.name}`, body: String(out.summary ?? ""), link: link(business.id, `automations?run=${runId}`), dedupeKey: `approve:${runId}` });
    await db.query(`UPDATE automations SET last_run_at = now() WHERE id = $1`, [a.id]);
    return { status: "awaiting_approval", summary: String(out.summary ?? "") };
  }
  Object.assign(out, await performActions(db, business, plan, runId));
  await finish(db, runId, "succeeded", out);
  await db.query(`UPDATE automations SET last_run_at = now() WHERE id = $1`, [a.id]);
  return { status: "succeeded", summary: String(out.summary ?? "") };
}

/** Carry out a plan. Idempotent: notifications and tasks are de-duplicated by key. */
export async function performActions(db: pg.PoolClient, business: any, plan: Plan, runId: string) {
  const res: Record<string, unknown> = {};
  if (plan.notify?.userIds.length) {
    const r = await notifyUsers(db, { workspaceId: business.workspace_id, businessId: business.id, userIds: plan.notify.userIds, kind: "automation", title: plan.notify.title, body: plan.notify.body, link: plan.notify.link, dedupeKey: plan.notify.dedupeKey });
    res.notified = r.notified;
  }
  if (plan.email) {
    if (!emailConfigured()) res.emailSkipped = "Email isn't configured on this platform (SMTP_URL); in-app notifications were sent instead.";
    else {
      const ids = await withAccess(db, business.id, plan.email.userIds);
      const to = (await db.query(`SELECT email FROM users WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => r.email);
      // Emails can't be un-sent: record the attempt first so a retry doesn't send twice.
      const sent = await db.query(`UPDATE automation_runs SET output = output || '{"emailing": true}' WHERE id = $1 AND NOT (output ? 'emailing') RETURNING id`, [runId]);
      if (to.length && sent.rowCount) {
        try {
          await sendEmail({ to, subject: plan.email.subject, text: plan.email.text, html: plan.email.html });
        } catch (e) {
          // Not sent: clear the marker so the retry can send it.
          await db.query(`UPDATE automation_runs SET output = output - 'emailing' WHERE id = $1`, [runId]);
          throw e;
        }
      }
      res.emailed = sent.rowCount ? to.length : 0;
    }
  }
  if (plan.tasks?.length) {
    const ids: string[] = [];
    for (const t of plan.tasks) {
      const assignee = t.assigneeId ? (await withAccess(db, business.id, [t.assigneeId]))[0] ?? null : null;
      const r = await db.query(
        `INSERT INTO tasks (workspace_id, business_id, title, description, assignee_id, source, insight_id, automation_run_id, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, 'automation', $6, $7, $8) ON CONFLICT (business_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
        [business.workspace_id, business.id, t.title.slice(0, 200), t.description.slice(0, 2000), assignee, t.insightId, runId, t.dedupeKey],
      );
      if (r.rows[0]) ids.push(r.rows[0].id);
    }
    res.taskIds = ids;
    if (ids.length) await db.query("SELECT app.notify_business($1, 'tasks_updated', '{}')", [business.id]);
  }
  return res;
}

async function finish(db: pg.PoolClient, runId: string, status: string, output: Record<string, unknown>) {
  await db.query(`UPDATE automation_runs SET status = $2, output = output || $3::jsonb, finished_at = now(), error = NULL WHERE id = $1`, [runId, status, JSON.stringify(output)]);
}

export async function markRunFailed(db: pg.PoolClient, runId: string, error: string, final: boolean) {
  await db.query(`UPDATE automation_runs SET status = $2, error = $3, finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE finished_at END WHERE id = $1`, [runId, final ? "failed" : "queued", error]);
  if (final) {
    const r = (await db.query(`SELECT r.business_id, a.name, a.workspace_id FROM automation_runs r JOIN automations a ON a.id = r.automation_id WHERE r.id = $1`, [runId])).rows[0];
    if (r) {
      await audit(db, { workspaceId: r.workspace_id, businessId: r.business_id, actorType: "system", action: "automation.run_failed", targetType: "automation_run", targetId: runId, metadata: { error } });
      await notifyUsers(db, { workspaceId: r.workspace_id, businessId: r.business_id, userIds: await businessAdmins(db, r.business_id), kind: "automation_failed", title: `Automation failed: ${r.name}`, body: error, link: link(r.business_id, `automations?run=${runId}`), dedupeKey: `failed:${runId}` });
    }
  }
}

// ------------------------------------------------------------------ email bodies

function emailText(narrative: string | null, lines: string[], url: string, demo: boolean) {
  return [demo ? "DEMO BUSINESS — sample data.\n" : "", narrative ? `${narrative}\n` : "", ...lines.map((l) => `• ${l.replace(/\s*\[R\d+\]/g, "")}`), "", `Full report with sources and evidence: ${url}`].join("\n");
}
function emailHtml(title: string, narrative: string | null, lines: string[], url: string, demo: boolean) {
  return `<div style="font-family:system-ui,sans-serif;max-width:560px">${demo ? '<p style="color:#b45309"><b>Demo business — sample data.</b></p>' : ""}<h2>${escapeHtml(title)}</h2>${narrative ? `<p>${escapeHtml(narrative).replace(/\n/g, "<br>")}</p>` : ""}<ul>${lines.map((l) => `<li>${escapeHtml(l.replace(/\s*\[R\d+\]/g, ""))}</li>`).join("")}</ul><p><a href="${url}">Open the full report with sources and evidence</a></p></div>`;
}

export type { AutomationSpec };
