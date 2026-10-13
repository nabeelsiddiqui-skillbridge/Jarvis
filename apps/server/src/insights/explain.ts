import type pg from "pg";
import { AiUnavailable, NARRATIVE_RULES, aiConfigured, aiText } from "../ai/complete.js";

/**
 * AI explanation for an insight: possible causes and what to check, written only
 * from the insight's own evidence. Labelled in the UI as unverified.
 */
export async function explainInsight(db: pg.PoolClient, insightId: string) {
  const { rows } = await db.query(`SELECT i.*, b.name AS business_name, b.industry FROM insights i JOIN businesses b ON b.id = i.business_id WHERE i.id = $1`, [insightId]);
  const ins = rows[0];
  if (!ins) return;
  if (!aiConfigured()) {
    await db.query(`UPDATE insights SET explanation_status = 'unavailable' WHERE id = $1`, [insightId]);
    return;
  }
  const payload = {
    business: { name: ins.business_name, industry: ins.industry },
    finding: ins.title, detail: ins.finding, impact: ins.impact, period: ins.period, comparison: ins.comparison,
    largest_contributors: ins.drivers, evidence: (ins.evidence as any[]).map((e) => ({ ...e, sources: e.sources?.map((s: any) => ({ provider: s.provider, stale: s.stale, latestDataDate: s.latestDataDate })) })),
  };
  try {
    const { text, model } = await aiText({
      system: `${NARRATIVE_RULES}\n\nTask: in at most 90 words, give two or three possible explanations for this finding and what to check to confirm each. Start with "Possible explanations:". Cite evidence ids (I1, I2…) when you refer to a figure. If the data can't support an explanation, say what additional data would help.`,
      user: JSON.stringify(payload),
      maxTokens: 2000,
      usage: { workspaceId: ins.workspace_id, businessId: ins.business_id, feature: "insight_explanation" },
    });
    await db.query(`UPDATE insights SET explanation = $2, explanation_status = 'ready', explanation_model = $3 WHERE id = $1`, [insightId, text, model]);
  } catch (e) {
    if (e instanceof AiUnavailable) {
      await db.query(`UPDATE insights SET explanation_status = 'unavailable' WHERE id = $1`, [insightId]);
      return;
    }
    await db.query(`UPDATE insights SET explanation_status = 'failed' WHERE id = $1`, [insightId]);
    throw e;
  }
}
