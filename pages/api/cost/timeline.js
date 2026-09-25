/**
 * GET /api/cost/timeline?month=YYYY-MM
 *
 * Private — accessible ONLY to COST_MONITOR_EMAIL.
 * Returns daily time-series data for the trend chart:
 *   - Emails sent per day (from Firestore email_queue)
 *   - CF invocations per day (from GCP Cloud Monitoring)
 * Cached 5 minutes in-process.
 */
import { withApi } from '../../../lib/api-auth';
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';

const { queryFunctionInvocationsDaily } = require('../../../lib/gcp-monitoring');

const COST_MONITOR_EMAIL = (process.env.COST_MONITOR_EMAIL || 'icanntechindo@gmail.com').toLowerCase();

const _cache = new Map();
const CACHE_TTL_MS = 5 * 60_000;

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

function buildDayMap(year, month) {
  const days = {};
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    days[key] = { date: key, emails: 0, cfCalls: 0 };
  }
  return days;
}

async function buildTimeline(month) {
  const { year, month: m } = month;
  const { startISO, endISO, startDate, endDate } = monthBounds({ year, month: m });

  initializeFirebase();
  const db = admin.firestore();

  // Email counts per day from email_queue
  const emailSnap = await db.collection('email_queue')
    .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(startDate))
    .where('createdAt', '<', admin.firestore.Timestamp.fromDate(endDate))
    .limit(1000)
    .get();

  const days = buildDayMap(year, m);

  for (const doc of emailSnap.docs) {
    const data = doc.data();
    const ts = data.createdAt?.toDate?.();
    if (!ts) continue;
    const key = ts.toISOString().slice(0, 10);
    if (days[key]) days[key].emails++;
  }

  // CF invocations per day from GCP Monitoring
  const cfResult = await queryFunctionInvocationsDaily(startISO, endISO);
  if (cfResult.ok) {
    for (const { date, count } of cfResult.days) {
      if (days[date]) days[date].cfCalls = count;
    }
  }

  const series = Object.values(days).sort((a, b) => a.date.localeCompare(b.date));

  return {
    month: `${year}-${String(m).padStart(2, '0')}`,
    generatedAt: new Date().toISOString(),
    series,
    cfOk: cfResult.ok,
    cfReason: cfResult.reason || null,
  };
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

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
    const data = await buildTimeline(month);
    _cache.set(cacheKey, { ts: Date.now(), data });
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[api/cost/timeline]', err.message);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { permission: 'cost_monitor.view' });
