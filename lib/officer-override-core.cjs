/**
 * officer-override-core.cjs
 *
 * Pure business-logic function for the officer-override approval flow.
 * Accepts all external dependencies as arguments so it can be unit/integration
 * tested without Firebase, HTTP, or session infrastructure.
 *
 * Returns: { statusCode, body }
 */
const { isTeacherEmail, classesIntersect } = require('./teacher-auth');

const WINDOW_MS_DEFAULT = 10 * 60 * 1000;

/**
 * @param {object} params
 * @param {object|null}  params.session             - { email } from verifyCookie, or null
 * @param {string}       params.code                - 6-digit override code from request body
 * @param {string}       [params.officer]           - display name (admin only, optional)
 * @param {string}       [params.note]              - approval note (optional)
 * @param {object}       params.db                  - Firestore client (or mock)
 * @param {string}       params.tid                 - resolved tenant id
 * @param {function}     params.pickupEventsPath    - tenancy.pickupEventsPath
 * @param {function}     params.securityIncidentsPath - tenancy.securityIncidentsPath
 * @param {string}       params.teacherDomain       - e.g. 'binus.edu'
 * @param {number}       [params.windowMs]          - override time window (default 10 min)
 * @param {number}       [params.nowMs]             - override for Date.now() (tests)
 */
async function runOfficerOverride(params) {
  const {
    session,
    code,
    officer,
    note,
    db,
    tid,
    pickupEventsPath,
    securityIncidentsPath,
    teacherDomain,
    windowMs = WINDOW_MS_DEFAULT,
    nowMs = Date.now(),
  } = params;

  // Session required
  if (!session?.email) {
    return { statusCode: 401, body: { error: 'login required' } };
  }
  const actorEmail = String(session.email).toLowerCase();

  // User must exist in dashboard_users
  const userSnap = await db.collection('dashboard_users').doc(actorEmail).get();
  if (!userSnap.exists) {
    return { statusCode: 403, body: { error: 'account not authorized' } };
  }
  const user = userSnap.data() || {};
  const actorRole = user.role || 'viewer';

  if (!['owner', 'admin', 'teacher'].includes(actorRole)) {
    return { statusCode: 403, body: { error: 'insufficient role for pickup approval' } };
  }
  if (user.disabled) {
    return { statusCode: 403, body: { error: 'account disabled' } };
  }
  if (actorRole === 'teacher' && !isTeacherEmail(actorEmail, teacherDomain)) {
    return { statusCode: 403, body: { error: `teacher login must use @${teacherDomain}` } };
  }

  // Find the pickup event by override code within the time window
  const cutoffMs = nowMs - windowMs;
  const snap = await db.collection(pickupEventsPath(tid))
    .where('overrideCode', '==', String(code))
    .limit(10)
    .get();

  const recentDocs = snap.docs.filter((d) => {
    const ts = d.data().recordedAt;
    const ms = ts?.toMillis ? ts.toMillis() : (ts?.seconds ? ts.seconds * 1000 : 0);
    return ms > cutoffMs;
  });

  if (recentDocs.length === 0) {
    return { statusCode: 404, body: { error: 'no matching event in the last 10 minutes' } };
  }

  // Pick most recent
  recentDocs.sort((a, b) => {
    const ta = a.data().recordedAt;
    const tb = b.data().recordedAt;
    const ma = ta?.toMillis ? ta.toMillis() : (ta?.seconds ? ta.seconds * 1000 : 0);
    const mb = tb?.toMillis ? tb.toMillis() : (tb?.seconds ? tb.seconds * 1000 : 0);
    return mb - ma;
  });

  const doc = recentDocs[0];
  const ev = doc.data();

  // Teacher class-scope check
  if (actorRole === 'teacher') {
    const teacherClasses = Array.isArray(user.classScopes) ? user.classScopes : [];
    if (teacherClasses.length === 0) {
      return { statusCode: 403, body: { error: 'teacher has no class scope assigned' } };
    }
    const eventClasses = (ev.students || []).map((s) => s.homeroom);
    if (!classesIntersect(teacherClasses, eventClasses)) {
      return { statusCode: 403, body: { error: 'event not in your assigned class scope' } };
    }
  }

  // Idempotency check
  if (ev.officerOverride) {
    return { statusCode: 409, body: { error: 'event already overridden', by: ev.officerOverride.by } };
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
    at: new Date(nowMs).toISOString(),
  };

  await doc.ref.set({ officerOverride: override }, { merge: true });

  // Audit log (best-effort)
  try {
    await db.collection(securityIncidentsPath(tid)).add({
      kind: 'officer_override',
      eventId: ev.eventId || doc.id,
      employeeNo: ev.employeeNo,
      gate: ev.gate,
      chaperoneName: ev.chaperone?.name,
      override,
      createdAt: new Date(nowMs).toISOString(),
      resolved: true,
    });
  } catch {}

  return {
    statusCode: 200,
    body: {
      ok: true,
      eventId: ev.eventId || doc.id,
      chaperone: ev.chaperone?.name,
      gate: ev.gate,
      decision: ev.decision,
      _override: override, // included for test assertions; stripped by handler in prod if desired
    },
  };
}

module.exports = { runOfficerOverride };
