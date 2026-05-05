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
import { verifyCookie } from '../../auth/session';
const tenancy = require('../../../../lib/tenancy');

const WINDOW_MS = 10 * 60 * 1000;
const TEACHER_EMAIL_DOMAIN = (process.env.TEACHER_EMAIL_DOMAIN || 'binus.edu').toLowerCase();

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const parts = raw.split(';').map((p) => p.trim());
  for (const p of parts) {
    if (!p.startsWith(`${name}=`)) continue;
    return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

function normalizeClassSet(values) {
  return new Set((values || []).map((x) => String(x || '').trim().toUpperCase()).filter(Boolean));
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const { code, officer, note, tenant } = req.body || {};
  if (!code || !/^\d{6}$/.test(String(code))) {
    return res.status(400).json({ error: 'code must be a 6-digit number' });
  }
  initializeFirebase();
  const db = admin.firestore();
  const tid = tenant || tenancy.getTenantId();

  // Require authenticated user session for accountability.
  const sessionMarker = readCookie(req, '__session');
  const session = sessionMarker ? verifyCookie(sessionMarker) : null;
  if (!session?.email) {
    return res.status(401).json({ error: 'login required' });
  }
  const actorEmail = String(session.email).toLowerCase();
  const userSnap = await db.collection('dashboard_users').doc(actorEmail).get();
  if (!userSnap.exists) {
    return res.status(403).json({ error: 'account not authorized' });
  }
  const user = userSnap.data() || {};
  const actorRole = user.role || 'viewer';
  if (!['owner', 'admin', 'teacher'].includes(actorRole)) {
    return res.status(403).json({ error: 'insufficient role for pickup approval' });
  }
  if (user.disabled) {
    return res.status(403).json({ error: 'account disabled' });
  }
  if (actorRole === 'teacher' && !actorEmail.endsWith(`@${TEACHER_EMAIL_DOMAIN}`)) {
    return res.status(403).json({ error: `teacher login must use @${TEACHER_EMAIL_DOMAIN}` });
  }

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

  // Teacher can only validate events for their assigned classes.
  if (actorRole === 'teacher') {
    const teacherClasses = normalizeClassSet(user.classScopes || []);
    if (teacherClasses.size === 0) {
      return res.status(403).json({ error: 'teacher has no class scope assigned' });
    }
    const eventClasses = normalizeClassSet((ev.students || []).map((s) => s.homeroom));
    const allowed = [...eventClasses].some((cls) => teacherClasses.has(cls));
    if (!allowed) {
      return res.status(403).json({ error: 'event not in your assigned class scope' });
    }
  }

  if (ev.officerOverride) {
    return res.status(409).json({
      error: 'event already overridden',
      by: ev.officerOverride.by,
    });
  }

  const actorDisplay = actorRole === 'teacher'
    ? (user.name || actorEmail)
    : (officer && String(officer).trim().length >= 2 ? String(officer).trim() : (user.name || actorEmail));

  const override = {
    by: actorDisplay,
    byEmail: actorEmail,
    byRole: actorRole,
    classScopes: Array.isArray(user.classScopes) ? user.classScopes : [],
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
