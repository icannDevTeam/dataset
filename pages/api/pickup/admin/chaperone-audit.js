/**
 * GET /api/pickup/admin/chaperone-audit?id={chaperoneId}
 *
 * Returns the full timeline for a single chaperone:
 *   - Onboarding submission record (and its approval/rejection)
 *   - Every pickup_event (recordedAt desc, capped at 200)
 *   - Every security_incidents entry referencing this chaperone
 *
 * Used by /v2/chaperone/[id] audit page (#15).
 */
import admin from 'firebase-admin';
import { withAuth } from '../../../../lib/auth-middleware';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');

const EVENT_LIMIT = 200;

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'missing id' });
  const tid = tenancy.getTenantId(req.query.tenant);

  initializeFirebase();
  const db = admin.firestore();

  // Chaperone doc
  const chapRef = db.doc(`${tenancy.chaperonesPath(tid)}/${id}`);
  const chapSnap = await chapRef.get();
  if (!chapSnap.exists) return res.status(404).json({ error: 'chaperone not found' });
  const chap = chapSnap.data();
  const employeeNo = chap.employeeNo;

  // Pickup events (by employeeNo)
  const events = [];
  if (employeeNo) {
    const evSnap = await db.collection(tenancy.pickupEventsPath(tid))
      .where('employeeNo', '==', employeeNo)
      .limit(EVENT_LIMIT)
      .get();
    evSnap.forEach((d) => {
      const e = d.data();
      events.push({
        id: d.id,
        kind: 'pickup_event',
        at: tsToIso(e.recordedAt) || e.recordedAt,
        scannedAt: tsToIso(e.scannedAt) || e.scannedAt,
        decision: e.decision,
        cardState: e.cardState,
        gate: e.gate,
        deviceName: e.deviceName,
        students: (e.students || []).map((s) => s.name).filter(Boolean),
        officerOverride: e.officerOverride || null,
        capturePath: e.capturePath || null,
      });
    });
  }

  // Security incidents
  const incidents = [];
  try {
    const incSnap = await db.collection(tenancy.securityIncidentsPath(tid))
      .where('employeeNo', '==', employeeNo || '__none__')
      .limit(EVENT_LIMIT)
      .get();
    incSnap.forEach((d) => {
      const i = d.data();
      incidents.push({
        id: d.id,
        kind: 'security_incident',
        at: tsToIso(i.createdAt) || i.createdAt,
        type: i.kind,
        gate: i.gate,
        eventId: i.eventId,
        resolved: !!i.resolved,
        override: i.override || null,
      });
    });
  } catch {
    // missing index → just return empty
  }

  // Onboarding record (last referencing this chaperoneId in allocatedChaperones)
  let onboarding = null;
  try {
    const obSnap = await db.collection(tenancy.pickupOnboardingPath(tid))
      .where('allocatedChaperoneIds', 'array-contains', id)
      .orderBy('submittedAt', 'desc')
      .limit(1)
      .get();
    if (!obSnap.empty) {
      const o = obSnap.docs[0].data();
      onboarding = {
        id: obSnap.docs[0].id,
        submittedAt: tsToIso(o.submittedAt) || o.submittedAt,
        approvedAt: tsToIso(o.approvedAt) || o.approvedAt,
        status: o.status,
        guardian: o.guardian?.name,
      };
    }
  } catch {}

  // Sort in JS (avoids composite Firestore index on employeeNo + recordedAt/createdAt)
  events.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  incidents.sort((a, b) => (b.at || '').localeCompare(a.at || ''));

  return res.status(200).json({
    ok: true,
    chaperone: {
      id,
      employeeNo,
      name: chap.name,
      relationship: chap.relationship,
      authorizedStudentIds: chap.authorizedStudentIds || [],
      photoCount: (chap.photoUrls || []).length,
      lastSeenAt: tsToIso(chap.lastSeenAt) || chap.lastSeenAt,
      lastSeenGate: chap.lastSeenGate,
      enrollmentSummary: chap.enrollmentSummary || null,
      reenrollDueAt: tsToIso(chap.reenrollDueAt) || chap.reenrollDueAt,
    },
    onboarding,
    events,
    incidents,
  });
}

function tsToIso(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  return null;
}

export default withAuth(handler, { methods: ['GET'] });
