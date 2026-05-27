/**
 * /api/v2/admin/users/list — paginated Firebase Auth user directory.
 *
 * Owner-only by default. Requires sensitive_user_access.view_user_directory.
 * Returns 50 users per page; pass `?pageToken=...` to continue. Enriches
 * each row with the role from the `dashboard_users` Firestore mirror so
 * the UI can render role chips without a second round-trip.
 *
 * SECURITY NOTES
 *   - withApi enforces auth + CSRF + permission gate.
 *   - Rate-limited (30 req/min/IP) to prevent directory scraping.
 *   - We never expose passwordHash / passwordSalt / providerData secrets —
 *     only uid, email, displayName, disabled, lastSignInTime, plus a
 *     mirrored `role`. Photo URLs are dropped (not needed for this view).
 */
import { withApi } from '../../../../../lib/api-auth';
import { initializeFirebase, getFirebaseAdmin, getFirestoreDB } from '../../../../../lib/firebase-admin';

async function handler(req, res) {
  const pageToken = typeof req.query.pageToken === 'string' && req.query.pageToken.length > 0
    ? req.query.pageToken
    : undefined;

  try {
    initializeFirebase();
  } catch (err) {
    console.error('[v2/admin/users/list] firebase init failed', err.message);
    return res.status(500).json({ error: 'firebase_unavailable' });
  }
  const admin = getFirebaseAdmin();

  let listResult;
  try {
    listResult = await admin.auth().listUsers(50, pageToken);
  } catch (err) {
    console.error('[v2/admin/users/list] listUsers failed', err.message);
    return res.status(500).json({ error: 'list_failed' });
  }

  // Enrich with role from dashboard_users mirror (email-keyed).
  let roleMap = {};
  try {
    const db = getFirestoreDB();
    const emails = listResult.users
      .map((u) => (u.email || '').toLowerCase().trim())
      .filter(Boolean);
    if (emails.length > 0) {
      // Firestore `in` clause is capped at 30 — chunk just in case.
      const chunks = [];
      for (let i = 0; i < emails.length; i += 30) chunks.push(emails.slice(i, i + 30));
      const FieldPath = admin.firestore.FieldPath;
      const snaps = await Promise.all(
        chunks.map((c) =>
          db.collection('dashboard_users').where(FieldPath.documentId(), 'in', c).get()
        )
      );
      snaps.forEach((s) => s.forEach((doc) => {
        const d = doc.data() || {};
        roleMap[doc.id] = d.role || 'viewer';
      }));
    }
  } catch (err) {
    // Non-fatal: directory listing should still work if mirror lookup fails.
    console.warn('[v2/admin/users/list] role enrichment failed', err.message);
  }

  const users = listResult.users.map((u) => {
    const email = (u.email || '').toLowerCase().trim();
    return {
      uid: u.uid,
      email,
      displayName: u.displayName || '',
      disabled: !!u.disabled,
      lastSignInTime: u.metadata?.lastSignInTime || null,
      creationTime: u.metadata?.creationTime || null,
      role: roleMap[email] || 'viewer',
    };
  });

  return res.status(200).json({
    users,
    nextPageToken: listResult.pageToken || null,
  });
}

export default withApi(handler, {
  methods: ['GET'],
  permission: 'sensitive_user_access.view_user_directory',
  rateLimit: 30,
});
