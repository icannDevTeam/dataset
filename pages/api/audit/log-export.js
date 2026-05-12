/**
 * /api/audit/log-export — records a client-side download/print event.
 *
 * Many "exports" never round-trip through the server (e.g. pure client-side
 * CSV blobs built from already-fetched data). This endpoint exists so those
 * downloads still leave an audit trail with the same step-up password
 * confirmation as server-side exports. The `reauth: true` opt in `withApi`
 * already records `reauth_success` to security_events; this handler adds a
 * richer `audit_export` record with the action label and scope.
 */
import admin from 'firebase-admin';
import { withApi, logSecurityEvent } from '../../../lib/api-auth';
import { initializeFirebase, getFirestoreDB } from '../../../lib/firebase-admin';

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { action, label, scope, recordCount, filters } = req.body || {};
  if (!action || typeof action !== 'string' || action.length > 80) {
    return res.status(400).json({ error: 'action_required' });
  }

  const safeLabel = typeof label === 'string' ? label.slice(0, 200) : null;
  const safeScope = typeof scope === 'string' ? scope.slice(0, 80) : null;
  const safeCount = Number.isFinite(recordCount) ? Math.max(0, Math.floor(recordCount)) : null;
  const safeFilters = (filters && typeof filters === 'object')
    ? Object.fromEntries(
        Object.entries(filters)
          .filter(([k]) => typeof k === 'string' && k.length < 32)
          .slice(0, 16)
          .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 120) : v]),
      )
    : null;

  // Fire-and-forget Firestore audit row.
  setImmediate(async () => {
    try {
      initializeFirebase();
      const db = getFirestoreDB();
      await db.collection('audit_exports').add({
        action,
        label: safeLabel,
        scope: safeScope,
        recordCount: safeCount,
        filters: safeFilters,
        actorEmail: req.user?.email || null,
        actorRole: req.user?.role || null,
        actorUid: req.user?.uid || null,
        ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null,
        ua: (req.headers['user-agent'] || '').slice(0, 240),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error('[audit/log-export] write failed', err.message);
    }
  });

  // Mirror to security_events for the unified security feed.
  try {
    logSecurityEvent(req, 'audit_export', {
      email: req.user?.email,
      action,
      label: safeLabel,
      scope: safeScope,
      recordCount: safeCount,
    });
  } catch {}

  return res.status(200).json({ ok: true });
}

export default withApi(handler, { methods: ['POST'], reauth: true });
