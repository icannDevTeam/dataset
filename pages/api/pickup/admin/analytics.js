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
    const officerMap   = {};   // officer name -> overrides count
    const byHour       = new Array(24).fill(0).map(() => ({ total: 0, overridden: 0 }));
    const recent       = [];   // last events for activity feed

    // ── Facial-recognition signals ──────────────────────────────
    const confidenceValues = [];   // numeric confidences (0..1)
    let livenessChecked    = 0;
    let livenessPassed     = 0;
    let spoofAttempts      = 0;
    let lowConfidence      = 0;    // confidence < 0.7
    let unknownChaperone   = 0;
    const retriesValues    = [];
    const lowConfidenceFlags = [];   // surfaced in reports
    const spoofFlags         = [];   // surfaced in reports
    // Per-terminal FR rollup keyed by terminalId
    const byTerminalMap = {};   // terminalId -> { gate, total, avgConfidence, livenessPassRate, spoof, low, unknown }
    const initTerm = () => ({
      total: 0, gate: null,
      confSum: 0, confN: 0,
      livenessChecked: 0, livenessPassed: 0,
      spoof: 0, low: 0, unknown: 0,
      retriesSum: 0, retriesN: 0,
    });

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

      // officer overrides — track who did them
      if (isOverride) {
        const off = e.officerOverride?.officer || e.officerOverride?.name || 'Unknown';
        inc(officerMap, off);
      }

      // peak hours (WIB hour-of-day)
      try {
        const dt = e.recordedAt?.toDate ? e.recordedAt.toDate() : new Date(e.recordedAt);
        const wibHour = new Date(dt.getTime() + 7 * 3600 * 1000).getUTCHours();
        byHour[wibHour].total++;
        if (isOverride) byHour[wibHour].overridden++;
      } catch {}

      // ── FR signals ──────────────────────────────────────────
      const fr = e.fr || {};
      const tIdRaw = e.terminalId || gate || 'Unknown';
      if (!byTerminalMap[tIdRaw]) byTerminalMap[tIdRaw] = initTerm();
      const tBucket = byTerminalMap[tIdRaw];
      tBucket.total++;
      tBucket.gate = tBucket.gate || gate;
      if (typeof fr.confidence === 'number') {
        confidenceValues.push(fr.confidence);
        tBucket.confSum += fr.confidence; tBucket.confN++;
        if (fr.confidence < 0.7) {
          lowConfidence++;
          tBucket.low++;
          if (lowConfidenceFlags.length < 50) lowConfidenceFlags.push({
            id: doc.id,
            at: tsToWIBDate(e.recordedAt) || date,
            gate, terminalId: tIdRaw,
            chaperone: chapName,
            confidence: parseFloat(fr.confidence.toFixed(3)),
          });
        }
      }
      if (typeof fr.livenessPassed === 'boolean') {
        livenessChecked++;
        tBucket.livenessChecked++;
        if (fr.livenessPassed) { livenessPassed++; tBucket.livenessPassed++; }
      }
      if (fr.spoof === true) {
        spoofAttempts++;
        tBucket.spoof++;
        if (spoofFlags.length < 50) spoofFlags.push({
          id: doc.id,
          at: tsToWIBDate(e.recordedAt) || date,
          gate, terminalId: tIdRaw,
          chaperone: chapName,
          livenessScore: typeof fr.liveness === 'number' ? parseFloat(fr.liveness.toFixed(3)) : null,
        });
      }
      if (typeof fr.retries === 'number') {
        retriesValues.push(fr.retries);
        tBucket.retriesSum += fr.retries; tBucket.retriesN++;
      }
      if (e.decision === 'unknown_chaperone') {
        unknownChaperone++;
        tBucket.unknown++;
      }

      // recent activity (collect first 50, snap is desc-ordered)
      if (recent.length < 50) {
        const dt = e.recordedAt?.toDate ? e.recordedAt.toDate() : new Date(e.recordedAt);
        recent.push({
          id: doc.id,
          at: dt?.toISOString?.() || null,
          gate,
          cardState,
          isOverride,
          chaperone: chapName || null,
          officer: e.officerOverride?.officer || null,
          note: e.officerOverride?.note || null,
          students: (e.students || []).map(s => ({
            name: s.name || s.fullName,
            homeroom: s.homeroom || s.class || null,
          })),
        });
      }
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

    const topOfficers = Object.entries(officerMap)
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    // Peak hours: find busiest hour
    const peakHourIdx = byHour.reduce((best, h, i) => h.total > byHour[best].total ? i : best, 0);
    const peakHour = byHour[peakHourIdx].total > 0
      ? { hour: peakHourIdx, count: byHour[peakHourIdx].total }
      : null;

    const avgPerDay    = totalDays > 0 ? Math.round((totalPickups / totalDays) * 10) / 10 : 0;
    const approvalRate = totalPickups > 0 ? Math.round((autoApproved / totalPickups) * 1000) / 10 : 0;
    const overrideRate = totalPickups > 0 ? Math.round((officerOverridden / totalPickups) * 1000) / 10 : 0;

    // ── FR rollups ───────────────────────────────────────────────
    const cAvg = confidenceValues.length
      ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length
      : null;
    const fr = {
      sample: confidenceValues.length,
      confidence: {
        avg: cAvg != null ? parseFloat((cAvg * 100).toFixed(1)) : null,
        min: confidenceValues.length ? parseFloat((Math.min(...confidenceValues) * 100).toFixed(1)) : null,
        max: confidenceValues.length ? parseFloat((Math.max(...confidenceValues) * 100).toFixed(1)) : null,
        distribution: {
          below50: confidenceValues.filter(v => v < 0.5).length,
          '50to70': confidenceValues.filter(v => v >= 0.5 && v < 0.7).length,
          '70to90': confidenceValues.filter(v => v >= 0.7 && v < 0.9).length,
          above90: confidenceValues.filter(v => v >= 0.9).length,
        },
      },
      liveness: {
        checked: livenessChecked,
        passed: livenessPassed,
        passRate: livenessChecked ? parseFloat(((livenessPassed / livenessChecked) * 100).toFixed(1)) : null,
      },
      spoofAttempts,
      lowConfidence,
      unknownChaperone,
      retriesAvg: retriesValues.length
        ? parseFloat((retriesValues.reduce((a, b) => a + b, 0) / retriesValues.length).toFixed(2))
        : null,
      lowConfidenceFlags: lowConfidenceFlags.sort((a, b) => a.confidence - b.confidence),
      spoofFlags,
    };
    const byTerminal = Object.entries(byTerminalMap)
      .map(([terminalId, v]) => ({
        terminalId,
        gate: v.gate || terminalId,
        total: v.total,
        avgConfidence: v.confN ? parseFloat(((v.confSum / v.confN) * 100).toFixed(1)) : null,
        livenessPassRate: v.livenessChecked
          ? parseFloat(((v.livenessPassed / v.livenessChecked) * 100).toFixed(1)) : null,
        spoof: v.spoof,
        lowConfidence: v.low,
        unknownChaperone: v.unknown,
        avgRetries: v.retriesN ? parseFloat((v.retriesSum / v.retriesN).toFixed(2)) : null,
      }))
      .sort((a, b) => b.total - a.total);

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
      byHour,
      peakHour,
      topChaperones,
      topOfficers,
      recent,
      fr,
      byTerminal,
    });
  } catch (err) {
    console.error('[pickup/admin/analytics]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withAuth(handler, { methods: ['GET'] });
