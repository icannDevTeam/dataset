/**
 * GET /api/cost/summary?month=YYYY-MM
 *
 * Private — accessible ONLY to COST_MONITOR_EMAIL (icanntechindo@gmail.com).
 * Returns aggregated cost + utilization snapshot for all monitored services.
 * Cached 60s in-process to avoid hammering external APIs on every page refresh.
 */
import { withApi } from '../../../lib/api-auth';
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';

const tenancy = require('../../../lib/tenancy');
const {
  queryFunctionInvocations,
  queryFunctionGBSeconds,
} = require('../../../lib/gcp-monitoring');
const {
  collectResend,
  collectAnthropic,
  collectVercel,
  collectGitHubCopilot,
  collectDomainHealth,
} = require('../../../lib/cost-collectors');

const COST_MONITOR_EMAIL = (process.env.COST_MONITOR_EMAIL || 'icanntechindo@gmail.com').toLowerCase();

// Simple in-process cache keyed by month string
const _cache = new Map();
const CACHE_TTL_MS = 60_000; // 60 seconds

function parseMonth(monthParam) {
  const now = new Date();
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [year, month] = monthParam.split('-').map(Number);
    return { year, month };
  }
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

function monthBounds({ year, month }) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { startISO: start.toISOString(), endISO: end.toISOString(), startDate: start, endDate: end };
}

async function buildSummary(month) {
  const { year, month: m } = month;
  const { startISO, endISO, startDate, endDate } = monthBounds({ year, month: m });

  initializeFirebase();
  const db = admin.firestore();

  // ── Firestore: email_queue stats ──────────────────────────────────
  const emailQueueSnap = await db.collection('email_queue')
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startDate))
    .where('createdAt', '<', admin.firestore.Timestamp.fromDate(endDate))
    .limit(500)
    .get();

  const emailQueueStats = { total: 0, sent: 0, failed: 0, pending: 0 };
  for (const doc of emailQueueSnap.docs) {
    const data = doc.data();
    emailQueueStats.total++;
    const status = String(data.status || '');
    if (status === 'sent' || status === 'delivered') emailQueueStats.sent++;
    else if (status === 'failed' || status === 'error') emailQueueStats.failed++;
    else emailQueueStats.pending++;
  }

  // ── GCP Cloud Functions ───────────────────────────────────────────
  const [cfInvocations, cfGBSeconds] = await Promise.all([
    queryFunctionInvocations(startISO, endISO),
    queryFunctionGBSeconds(startISO, endISO),
  ]);

  // CF free tier: 2M invocations/month, 400K GB-seconds/month
  const CF_INV_FREE = 2_000_000;
  const CF_GBS_FREE = 400_000;
  const cfInvTotal = cfInvocations.total || 0;
  const cfGBsTotal = cfGBSeconds.totalGBs || 0;
  const cfInvPct = Math.min(Math.round((cfInvTotal / CF_INV_FREE) * 100), 100);
  const cfGBsPct = Math.min(Math.round((cfGBsTotal / CF_GBS_FREE) * 100), 100);

  // ── External collectors (parallel) ───────────────────────────────
  const [resend, anthropic, vercel, github, domains] = await Promise.all([
    collectResend(startISO, endISO),
    collectAnthropic(startISO, endISO),
    collectVercel(),
    collectGitHubCopilot(),
    collectDomainHealth(),
  ]);

  // ── Totals ────────────────────────────────────────────────────────
  const ghCost = parseFloat(github.data?.estimatedCost || '0');
  const claudeCost = parseFloat(anthropic.data?.estimatedCost || '0');
  const resendCost = parseFloat(resend.data?.estimatedCost || '0');
  const vercelCost = parseFloat(vercel.data?.estimatedCost || '0');
  const totalEstimated = ghCost + claudeCost + resendCost + vercelCost;

  // Insight: largest delta / most noteworthy metric
  const insight = buildInsight({ resend, anthropic, github, cfInvTotal });

  // Count services on free tier
  const freeServices = [
    resendCost === 0,
    claudeCost === 0,
    cfInvTotal < CF_INV_FREE,
    vercelCost === 0,
    !github.ok || ghCost === 0,
  ].filter(Boolean).length;

  return {
    month: `${year}-${String(m).padStart(2, '0')}`,
    generatedAt: new Date().toISOString(),
    insight,
    totals: {
      estimatedCost: totalEstimated.toFixed(2),
      freeServices,
      totalServices: 5,
    },
    services: {
      cloudFunctions: {
        ok: cfInvocations.ok,
        invocations: cfInvTotal,
        gbSeconds: cfGBsTotal,
        invPct: cfInvPct,
        gbsPct: cfGBsPct,
        byFunction: cfInvocations.byFunction || {},
        freeInvLimit: CF_INV_FREE,
        freeGBsLimit: CF_GBS_FREE,
        estimatedCost: '0.00',
        reason: cfInvocations.reason || null,
      },
      resend: {
        ok: resend.ok,
        ...(resend.data || {}),
        reason: resend.reason || null,
      },
      anthropic: {
        ok: anthropic.ok,
        ...(anthropic.data || {}),
        reason: anthropic.reason || null,
      },
      vercel: {
        ok: vercel.ok,
        ...(vercel.data || {}),
        reason: vercel.reason || null,
      },
      github: {
        ok: github.ok,
        ...(github.data || {}),
        reason: github.reason || null,
      },
      domains: {
        ok: domains.ok,
        ...(domains.data || {}),
        reason: domains.reason || null,
      },
      emailQueue: {
        ok: true,
        ...emailQueueStats,
      },
    },
  };
}

function buildInsight({ resend, anthropic, github, cfInvTotal }) {
  if (!resend.ok && !anthropic.ok && !github.ok) {
    return 'Some external API connections need setup — add RESEND_API_KEY, ANTHROPIC_API_KEY, VERCEL_TOKEN.';
  }
  const emailTotal = resend.data?.total || 0;
  const emailPct = resend.data?.usagePct || 0;
  const tokens = anthropic.data?.totalTokens || 0;
  const claudeCost = parseFloat(anthropic.data?.estimatedCost || '0');
  const githubCost = parseFloat(github.data?.estimatedCost || '0');

  if (githubCost > 0 && claudeCost > 0) {
    return `GitHub Copilot ($${githubCost.toFixed(0)}/mo) and Claude API (~$${claudeCost.toFixed(2)}) are the main costs this month.`;
  }
  if (githubCost > 0) {
    return `GitHub Copilot is $${githubCost.toFixed(0)}/mo (${github.data?.activeSeats || 1} seat). All other services on free tier.`;
  }
  if (emailTotal > 0) {
    return `${emailTotal} emails sent this month (${emailPct}% of free tier). ${cfInvTotal} Cloud Function calls. All costs $0.`;
  }
  return 'All services on free tier. No infrastructure costs this month.';
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  // Extra email gate on top of permission check
  if (req.user?.email?.toLowerCase() !== COST_MONITOR_EMAIL) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const month = parseMonth(req.query.month);
  const cacheKey = `${month.year}-${month.month}`;

  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached.data);
  }

  try {
    const data = await buildSummary(month);
    _cache.set(cacheKey, { ts: Date.now(), data });
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[api/cost/summary]', err.message);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { permission: 'cost_monitor.view' });
