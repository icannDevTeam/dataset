/**
 * GET /api/pickup/admin/analytics
 *
 * Pickup event analytics aggregated from pickup_events collection.
 *
 * Query params:
 *   from     YYYY-MM-DD  (default: today WIB)
 *   to       YYYY-MM-DD  (default: today WIB)
 *   tenant   string      (optional)
 *
 * Response: {
 *   ok: true,
 *   range: { from, to, totalDays },
 *   summary: {
 *     totalPickups, autoApproved, officerOverridden, flagged, avgPerDay,
 *     approvalRate, overrideRate
 *   },
 *   byDate:      [{ date, total, autoApproved, overridden, green, yellow, red }],
 *   byGate:      [{ gate, total, autoApproved, overridden, green, yellow, red }],
 *   byClass:     [{ homeroom, total }],
 *   byCardState: { green, yellow, red },
 *   topChaperones: [{ name, total }],   // most frequent pickup persons
 * }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
const tenancy = require('../../../../lib/tenancy');

// ── Helpers ────────────────────────────────────────────────────────────────

function getWIBToday() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function parseDate(str, fallback) {
  if (!str || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return fallback;
  const d = new Date(str + 'T00:00:00Z');
  return isNaN(d.getTime()) ? fallback : str;
}

function tsToWIBDate(ts) {
  // ts: Firestore Timestamp or ISO string
  try {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    // shift to WIB (UTC+7)
    const wib = new Date(d.getTime() + 7 * 3600 * 1000);
    return wib.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function countDays(from, to) {
  const ms = new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z');
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

function inc(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

// ── Handler ────────────────────────────────────────────────────────────────

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  const today = getWIBToday();
  const from = parseDate(req.query.from, today);
  const to   = parseDate(req.query.to,   today);
  const tid  = tenancy.getTenantId(req.query.tenant);

  // Date bounds in UTC (WIB date starts at UTC 17:00 previous day for WIB midnight)
  // Simpler: store as ISO and filter in WIB
  const fromMs = new Date(from + 'T00:00:00+07:00').getTime();
  const toMs   = new Date(to   + 'T23:59:59+07:00').getTime();

  try {
    initializeFirebase();
    const db = admin.firestore();

    const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);
    const toTs   = admin.firestore.Timestamp.fromMillis(toMs);

    // Query pickup_events in range (recordedAt is the primary timestamp)
    const snap = await db
      .collection(tenancy.pickupEventsPath(tid))
      .where('recordedAt', '>=', fromTs)
      .where('recordedAt', '<=', toTs)
      .orderBy('recordedAt', 'desc')
      .limit(5000)
      .get();

    // ── Aggregate ──────────────────────────────────────────────────────────
    const byDateMap    = {};   // date -> { total, autoApproved, overridden, green, yellow, red }
    const byGateMap    = {};   // gate -> same shape
    const byClassMap   = {};   // homeroom -> total
    const cardStateTot = { green: 0, yellow: 0, red: 0 };
    const chaperoneMap = {};   // chaperone name -> total

    let totalPickups      = 0;
    let autoApproved      = 0;
    let officerOverridden = 0;
    let flagged           = 0;

    const initBucket = () => ({ total: 0, autoApproved: 0, overridden: 0, green: 0, yellow: 0, red: 0 });

    snap.forEach((doc) => {
      const e = doc.data();
      totalPickups++;

      const date      = tsToWIBDate(e.recordedAt) || from;
      const gate      = e.gate || e.deviceName || 'Unknown';
      const cardState = (e.cardState || 'green').toLowerCase();
      const isOverride = !!e.officerOverride;
      const isGreen    = cardState === 'green';

      if (isOverride) officerOverridden++;
      else if (isGreen) autoApproved++;
      if (!isGreen) flagged++;

      // byDate
      if (!byDateMap[date]) byDateMap[date] = initBucket();
      byDateMap[date].total++;
      if (isOverride)    byDateMap[date].overridden++;
      else if (isGreen)  byDateMap[date].autoApproved++;
      inc(byDateMap[date], cardState);

      // byGate
      if (!byGateMap[gate]) byGateMap[gate] = initBucket();
      byGateMap[gate].total++;
      if (isOverride)    byGateMap[gate].overridden++;
      else if (isGreen)  byGateMap[gate].autoApproved++;
      inc(byGateMap[gate], cardState);

      // cardState totals
      if (cardState in cardStateTot) cardStateTot[cardState]++;

      // byClass — from students array
      const homerooms = new Set();
      (e.students || []).forEach((s) => {
        if (s.homeroom) homerooms.add(s.homeroom);
        else if (s.class) homerooms.add(s.class);
      });
      homerooms.forEach((h) => inc(byClassMap, h));

      // chaperone frequency
      const chapName = e.chaperone?.name || e.chaperoneId;
      if (chapName) inc(chaperoneMap, chapName);
    });

    // ── Build output arrays ─────────────────────────────────────────────────

    // Fill byDate for every date in range (so chart has no gaps)
    const totalDays = countDays(from, to);
    const byDate = [];
    {
      const d = new Date(from + 'T00:00:00Z');
      const end = new Date(to + 'T00:00:00Z');
      while (d <= end) {
        const key = d.toISOString().slice(0, 10);
        byDate.push({ date: key, ...(byDateMap[key] || initBucket()) });
        d.setUTCDate(d.getUTCDate() + 1);
      }
    }

    const byGate = Object.entries(byGateMap)
      .map(([gate, v]) => ({ gate, ...v }))
      .sort((a, b) => b.total - a.total);

    const byClass = Object.entries(byClassMap)
      .map(([homeroom, total]) => ({ homeroom, total }))
      .sort((a, b) => b.total - a.total);

    const topChaperones = Object.entries(chaperoneMap)
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    const avgPerDay    = totalDays > 0 ? Math.round((totalPickups / totalDays) * 10) / 10 : 0;
    const approvalRate = totalPickups > 0 ? Math.round((autoApproved / totalPickups) * 1000) / 10 : 0;
    const overrideRate = totalPickups > 0 ? Math.round((officerOverridden / totalPickups) * 1000) / 10 : 0;

    return res.status(200).json({
      ok: true,
      range: { from, to, totalDays },
      summary: {
        totalPickups,
        autoApproved,
        officerOverridden,
        flagged,
        avgPerDay,
        approvalRate,
        overrideRate,
      },
      byDate,
      byGate,
      byClass,
      byCardState: cardStateTot,
      topChaperones,
    });
  } catch (err) {
    console.error('[pickup/admin/analytics]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withAuth(handler, { methods: ['GET'] });
