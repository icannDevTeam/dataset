/**
 * POST /api/pickup/teacher/release
 *
 * Teacher/admin release workflow for pickup events.
 * Body: { eventId, action: 'release'|'hold'|'escalate', note?, captureStoragePath?, tenant? }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { verifyCookie } from '../../auth/session';
const tenancy = require('../../../../lib/tenancy');

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const p of raw.split(';').map((x) => x.trim())) {
    if (p.startsWith(`${name}=`)) return decodeURIComponent(p.slice(name.length + 1));
  }
  return null;
}

function normScopes(list) {
  return Array.isArray(list)
    ? list.map((x) => String(x || '').trim().toUpperCase()).filter(Boolean)
    : [];
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const { eventId, action, note, captureStoragePath, tenant } = req.body || {};
  const normalizedAction = String(action || '').toLowerCase();
  if (!eventId || typeof eventId !== 'string') {
    return res.status(400).json({ error: 'eventId is required' });
  }
  if (!['release', 'hold', 'escalate'].includes(normalizedAction)) {
    return res.status(400).json({ error: "action must be 'release', 'hold', or 'escalate'" });
  }

  const sessionMarker = readCookie(req, '__session');
  const session = sessionMarker ? verifyCookie(sessionMarker) : null;
  if (!session?.email) return res.status(401).json({ error: 'login required' });

  initializeFirebase();
  const db = admin.firestore();

  const actorEmail = String(session.email).toLowerCase();
  const userSnap = await db.collection('dashboard_users').doc(actorEmail).get();
  if (!userSnap.exists) return res.status(403).json({ error: 'account not authorized' });

  const user = userSnap.data() || {};
  if (user.disabled) return res.status(403).json({ error: 'account disabled' });

  const role = String(user.role || 'viewer');
  const isTeacher = role === 'teacher';
  if (!['owner', 'admin', 'teacher'].includes(role)) {
    return res.status(403).json({ error: 'insufficient role' });
  }

  const classScopes = normScopes(user.classScopes);
  if (isTeacher && classScopes.length === 0) {
    return res.status(403).json({ error: 'teacher has no class scope assigned' });
  }

  const tid = tenancy.getTenantId(tenant);
  const eventRef = db.doc(`${tenancy.pickupEventsPath(tid)}/${eventId}`);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) return res.status(404).json({ error: 'event not found' });

  const ev = eventSnap.data() || {};
  const eventClasses = (ev.students || [])
    .map((s) => String(s.homeroom || '').trim().toUpperCase())
    .filter(Boolean);

  if (isTeacher) {
    const scopeSet = new Set(classScopes);
    const inScope = eventClasses.some((c) => scopeSet.has(c));
    if (!inScope) {
      return res.status(403).json({ error: 'event not in your assigned class scope' });
    }
  }

  const cardState = String(ev.cardState || 'green').toLowerCase();
  if (normalizedAction === 'release' && cardState === 'red' && !captureStoragePath) {
    return res.status(400).json({ error: 'red card release requires captureStoragePath' });
  }
  if (normalizedAction === 'escalate' && cardState !== 'red') {
    return res.status(400).json({ error: 'escalate is only valid for red card events' });
  }

  const releasePayload = {
    by: actorEmail,
    displayName: user.name || actorEmail,
    at: admin.firestore.FieldValue.serverTimestamp(),
    action: normalizedAction,
    flagged: cardState === 'red',
    note: typeof note === 'string' ? note.slice(0, 500) : null,
  };
  if (captureStoragePath && typeof captureStoragePath === 'string') {
    releasePayload.captureStoragePath = captureStoragePath;
  }

  const nextStatus = normalizedAction === 'release'
    ? 'released'
    : normalizedAction === 'hold'
      ? 'held'
      : 'awaiting_security';

  const extra = normalizedAction === 'escalate'
    ? {
      securityEscalation: {
        by: actorEmail,
        displayName: user.name || actorEmail,
        at: admin.firestore.FieldValue.serverTimestamp(),
        reason: typeof note === 'string' && note.trim() ? note.slice(0, 500) : 'red card escalation from teacher desk',
      },
    }
    : {};

  await eventRef.set({
    status: nextStatus,
    teacherRelease: releasePayload,
    ...extra,
  }, { merge: true });

  return res.status(200).json({
    ok: true,
    eventId,
    action: normalizedAction,
    flagged: cardState === 'red',
  });
}
