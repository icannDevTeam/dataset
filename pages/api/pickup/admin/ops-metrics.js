/**
 * GET /api/pickup/admin/ops-metrics
 *
 * Per-gate/terminal operational metrics. Aggregates pickup_events and
 * security_incidents to produce interface-level counters suitable for
 * the Cisco-style operations display.
 *
 * Returns one "interface" record per terminal/gate seen in pickup_events
 * or the terminals collection, merged with Hikvision terminal metadata.
 *
 * Query params:
 *   tenant   string   (optional)
 *
 * Response:
 * {
 *   ok: true,
 *   generatedAt: ISO,
 *   interfaces: [{
 *     id, name, hardware, ip, gradeLabel, gateLabel, enabled,
 *     status: 'up'|'down'|'unknown',
 *     lastSeenAt,
 *     metrics: {
 *       total24h, total1h, total5min,
 *       unknownChaperone, spoofAttempts, lowConfidence, officerOverrides,
 *       inputErrors,   // sum of unknownChaperone + spoofAttempts
 *       outputDrops,   // events that fired an incident
 *       avgConfidence, // 0-100
 *       ratePerMin,    // events per minute over last hour
 *     },
 *     lastEvent: { at, chaperoneId, studentName, cardState, confidence } | null,
 *     recentEvents: [{ at, cardState, confidence, officerOverride }],
 *   }]
 * }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

function tsMs(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'string') return Date.parse(v);
  return null;
}
function tsIso(v) {
  const ms = tsMs(v);
  return ms ? new Date(ms).toISOString() : null;
}

function emptyMetrics() {
  return {
    total24h: 0, total1h: 0, total5min: 0,
    unknownChaperone: 0, spoofAttempts: 0, lowConfidence: 0, officerOverrides: 0,
    inputErrors: 0, outputDrops: 0,
    avgConfidence: null,
    ratePerMin: null,
    confidenceSum: 0, confidenceN: 0,
  };
}

function terminalNaturalCompare(aName, bName) {
  const a = String(aName || '').trim();
  const b = String(bName || '').trim();
  const am = a.match(/^Terminal\s+(\d+)$/i);
  const bm = b.match(/^Terminal\s+(\d+)$/i);
  if (am && bm) {
    const an = parseInt(am[1], 10);
    const bn = parseInt(bm[1], 10);
    if (an !== bn) return an - bn;
  }
  if (am && !bm) return -1;
  if (!am && bm) return 1;
  return a.localeCompare(b);
}

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId(req.query.tenant);
  const now = Date.now();
  const cut24h = new Date(now - 24 * 3600 * 1000);
  const cut1h  = now - 3600 * 1000;
  const cut5m  = now - 5 * 60 * 1000;

  // ── 1. Pull terminals registry ─────────────────────────────────────────────
  const terminalsMap = {};
  try {
    const tSnap = await db.collection(tenancy.terminalsPath(tid)).get();
    tSnap.forEach((doc) => {
      const d = doc.data();
      terminalsMap[doc.id] = {
        id: doc.id,
        name: d.name || doc.id,
        hardware: d.hardware || d.deviceName || null,
        ip: d.ip || null,
        gradeLabel: d.gradeLabel || null,
        gateLabel: d.gateLabel || null,
        enabled: d.enabled !== false,
        lastSeenAt: tsIso(d.lastSeenAt),
        windowOpen: d.windowOpen || null,
        windowClose: d.windowClose || null,
      };
    });
  } catch { /* terminals collection may not exist yet */ }

  // ── 2. Pull pickup_events last 24h ─────────────────────────────────────────
  const interfaceMap = {}; // key: gate name/id

  const evSnap = await db.collection(tenancy.pickupEventsPath(tid))
    .where('recordedAt', '>=', admin.firestore.Timestamp.fromDate(cut24h))
    .orderBy('recordedAt', 'desc')
    .limit(3000)
    .get();

  evSnap.forEach((doc) => {
    const e = doc.data();
    const gate = e.gate || e.deviceName || e.terminalId || 'Unknown';
    if (!interfaceMap[gate]) {
      interfaceMap[gate] = {
        gateKey: gate,
        lastEvent: null,
        recentEvents: [],
        metrics: emptyMetrics(),
        terminalId: e.terminalId || null,
      };
    }
    const iface = interfaceMap[gate];
    const m = iface.metrics;
    const evMs = tsMs(e.recordedAt);

    m.total24h++;
    if (evMs && evMs >= cut1h) m.total1h++;
    if (evMs && evMs >= cut5m) m.total5min++;

    const cardState = (e.cardState || 'green').toLowerCase();
    if (e.officerOverride) m.officerOverrides++;
    if (cardState === 'red') m.unknownChaperone++;
    if (e.spoofDetected || e.livenessFailed) m.spoofAttempts++;
    if (e.confidence != null && e.confidence < 0.7) m.lowConfidence++;

    if (e.confidence != null) {
      m.confidenceSum += e.confidence * 100;
      m.confidenceN++;
    }

    const evShape = {
      id: doc.id,
      at: tsIso(e.recordedAt),
      atMs: evMs,
      chaperoneId: e.chaperoneId || null,
      studentName: e.studentName || null,
      cardState,
      confidence: e.confidence != null ? Math.round(e.confidence * 100) : null,
      officerOverride: !!e.officerOverride,
    };

    if (!iface.lastEvent || (evMs && evMs > tsMs(iface.lastEvent?.atMs))) {
      iface.lastEvent = evShape;
    }
    if (iface.recentEvents.length < 8) iface.recentEvents.push(evShape);
  });

  // Finalize metrics
  for (const iface of Object.values(interfaceMap)) {
    const m = iface.metrics;
    m.inputErrors = m.unknownChaperone + m.spoofAttempts;
    m.outputDrops = m.unknownChaperone;
    m.avgConfidence = m.confidenceN > 0 ? Math.round(m.confidenceSum / m.confidenceN) : null;
    m.ratePerMin = m.total1h > 0 ? parseFloat((m.total1h / 60).toFixed(2)) : 0;
    delete m.confidenceSum; delete m.confidenceN;
  }

  // ── 3. Pull security_incidents for output drops ────────────────────────────
  try {
    const secSnap = await db.collection(tenancy.securityIncidentsPath(tid))
      .where('createdAt', '>=', cut24h.toISOString())
      .limit(500)
      .get();
    secSnap.forEach((doc) => {
      const s = doc.data();
      const gate = s.gate || 'Unknown';
      if (interfaceMap[gate]) interfaceMap[gate].metrics.outputDrops++;
    });
  } catch { /* non-critical */ }

  // ── 4. Merge terminal registry into interface map ──────────────────────────
  // Add terminals with no events (show as interfaces with zero traffic)
  for (const [id, term] of Object.entries(terminalsMap)) {
    const matchKey = term.name || id;
    if (!interfaceMap[matchKey]) {
      interfaceMap[matchKey] = {
        gateKey: matchKey,
        lastEvent: null,
        recentEvents: [],
        metrics: emptyMetrics(),
        terminalId: id,
      };
    }
  }

  // ── 5. Build interface list with status ────────────────────────────────────
  const interfaces = Object.values(interfaceMap).map((iface) => {
    const termMeta = terminalsMap[iface.gateKey]
      || Object.values(terminalsMap).find((t) => t.name === iface.gateKey)
      || {};

    const lastSeenMs = tsMs(termMeta.lastSeenAt) || iface.lastEvent?.atMs || null;
    const msSinceLastSeen = lastSeenMs ? now - lastSeenMs : null;

    let status = 'unknown';
    if (msSinceLastSeen !== null) {
      // Up = seen within last 10 minutes; down = not seen for 10+ min
      status = msSinceLastSeen < 10 * 60 * 1000 ? 'up' : 'down';
    }
    if (iface.metrics.total5min > 0) status = 'up';

    return {
      id: termMeta.id || iface.gateKey,
      name: termMeta.name || iface.gateKey,
      hardware: termMeta.hardware || 'DS-K1T3xxMFX',
      ip: termMeta.ip || null,
      gradeLabel: termMeta.gradeLabel || null,
      gateLabel: termMeta.gateLabel || null,
      windowOpen: termMeta.windowOpen || null,
      windowClose: termMeta.windowClose || null,
      enabled: termMeta.enabled !== false,
      status,
      lastSeenAt: termMeta.lastSeenAt || iface.lastEvent?.at || null,
      msSinceLastSeen,
      metrics: iface.metrics,
      lastEvent: iface.lastEvent,
      recentEvents: iface.recentEvents,
    };
  });

  interfaces.sort((a, b) => terminalNaturalCompare(a.name, b.name));

  return res.status(200).json({
    ok: true,
    generatedAt: new Date().toISOString(),
    interfaces,
  });
}

export default withApi(handler, { methods: ['GET'], permission: 'analytics.view' });
