/**
 * GET /api/pickup/admin/security-heatmap?days=14
 *
 * Returns aggregated counts of security_incidents bucketed by:
 *   - day  (YYYY-MM-DD, in WIB)
 *   - hour (0..23)
 *   - kind (unknown_chaperone, suspended, reenroll_overdue, officer_override, etc.)
 *   - gate
 *
 * Used by /v2/security heatmap (#17).
 */
import admin from 'firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_DAYS = 60;

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const days = Math.max(1, Math.min(MAX_DAYS, parseInt(req.query.days || '14', 10)));
  const tid = tenancy.getTenantId(req.query.tenant);

  initializeFirebase();
  const db = admin.firestore();

  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  let snap;
  try {
    snap = await db.collection(tenancy.securityIncidentsPath(tid))
      .where('createdAt', '>=', cutoffIso)
      .orderBy('createdAt', 'desc')
      .limit(2000)
      .get();
  } catch (e) {
    // Fallback: scan recent without where (small datasets)
    snap = await db.collection(tenancy.securityIncidentsPath(tid))
      .limit(1000).get();
  }

  // Build buckets
  const byDayHour = {}; // "YYYY-MM-DD|HH" -> count
  const byKind = {};
  const byGate = {};
  const recent = [];
  const dayTotals = {};

  snap.forEach((d) => {
    const i = d.data();
    const at = i.createdAt;
    if (!at) return;
    const t = typeof at === 'string' ? Date.parse(at) : at?.toDate?.()?.getTime();
    if (!t || t < cutoffMs) return;

    const wib = new Date(t + WIB_OFFSET_MS);
    const day = `${wib.getUTCFullYear()}-${pad(wib.getUTCMonth() + 1)}-${pad(wib.getUTCDate())}`;
    const hour = wib.getUTCHours();
    const key = `${day}|${hour}`;
    byDayHour[key] = (byDayHour[key] || 0) + 1;
    dayTotals[day] = (dayTotals[day] || 0) + 1;

    const kind = i.kind || 'unknown';
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (i.gate) byGate[i.gate] = (byGate[i.gate] || 0) + 1;

    if (recent.length < 50) {
      recent.push({
        id: d.id,
        kind,
        at: typeof at === 'string' ? at : new Date(t).toISOString(),
        gate: i.gate || null,
        chaperoneName: i.chaperoneName || null,
        eventId: i.eventId || null,
        resolved: !!i.resolved,
      });
    }
  });

  // Generate the day axis (oldest → newest WIB)
  const dayAxis = [];
  const todayWib = new Date(Date.now() + WIB_OFFSET_MS);
  for (let n = days - 1; n >= 0; n--) {
    const d = new Date(todayWib.getTime() - n * 86400000);
    dayAxis.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }

  return res.status(200).json({
    ok: true,
    days,
    dayAxis,
    byDayHour,
    byKind,
    byGate,
    dayTotals,
    recent,
    total: snap.size,
  });
}

function pad(n) { return n < 10 ? `0${n}` : `${n}`; }

export default withAuth(handler, { methods: ['GET'] });
