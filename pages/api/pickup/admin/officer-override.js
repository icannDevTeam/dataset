/**
 * POST /api/pickup/admin/officer-override
 *
 * Officer types the 6-digit overrideCode shown on the TV card; if it matches
 * the latest non-OK pickup_event in the last 10 minutes, the event is flipped
 * to "approved by officer" — TV repaints the band and gate-officer can let
 * the chaperone through.
 *
 * Body: { code, officer, note?, tenant? }
 *
 * Returns: { ok, eventId, chaperone, gate }
 */
import admin from 'firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');

const WINDOW_MS = 10 * 60 * 1000;

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const { code, officer, note, tenant } = req.body || {};
  if (!code || !/^\d{6}$/.test(String(code))) {
    return res.status(400).json({ error: 'code must be a 6-digit number' });
  }
  if (!officer || String(officer).length < 2) {
    return res.status(400).json({ error: 'officer name required' });
  }

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenant || tenancy.getTenantId();

  // Query by overrideCode only (single-field index — no composite index needed).
  // Filter the time window in JS to avoid requiring a composite Firestore index.
  const cutoffMs = Date.now() - WINDOW_MS;
  const snap = await db.collection(tenancy.pickupEventsPath(tid))
    .where('overrideCode', '==', String(code))
    .limit(10).get();

  const recentDocs = snap.docs.filter((d) => {
    const ts = d.data().recordedAt;
    const ms = ts?.toMillis ? ts.toMillis() : (ts?.seconds ? ts.seconds * 1000 : 0);
    return ms > cutoffMs;
  });
  if (recentDocs.length === 0) {
    return res.status(404).json({
      error: 'no matching event in the last 10 minutes',
    });
  }
  // Pick the most recent match
  recentDocs.sort((a, b) => {
    const ta = a.data().recordedAt;
    const tb = b.data().recordedAt;
    const ma = ta?.toMillis ? ta.toMillis() : (ta?.seconds ? ta.seconds * 1000 : 0);
    const mb = tb?.toMillis ? tb.toMillis() : (tb?.seconds ? tb.seconds * 1000 : 0);
    return mb - ma;
  });

  const doc = recentDocs[0];
  const ev = doc.data();
  if (ev.officerOverride) {
    return res.status(409).json({
      error: 'event already overridden',
      by: ev.officerOverride.by,
    });
  }

  const override = {
    by: String(officer),
    note: note ? String(note).slice(0, 200) : null,
    decision: 'approved',
    at: new Date().toISOString(),
  };
  await doc.ref.set({ officerOverride: override }, { merge: true });

  // Append a security_incidents resolution note for audit
  try {
    await db.collection(tenancy.securityIncidentsPath(tid)).add({
      kind: 'officer_override',
      eventId: ev.eventId || doc.id,
      employeeNo: ev.employeeNo,
      gate: ev.gate,
      chaperoneName: ev.chaperone?.name,
      override,
      createdAt: new Date().toISOString(),
      resolved: true,
    });
  } catch {}

  return res.status(200).json({
    ok: true,
    eventId: ev.eventId || doc.id,
    chaperone: ev.chaperone?.name,
    gate: ev.gate,
    decision: ev.decision,
  });
}

export default withAuth(handler, { methods: ['POST'] });
