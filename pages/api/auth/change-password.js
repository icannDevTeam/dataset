/**
 * POST /api/auth/change-password
 *
 * User-initiated password change. Used both for the forced first-login
 * change (when `mustChangePassword` is true on their Firestore doc) and
 * for voluntary password rotation.
 *
 * Body: { newPassword: string }
 *
 * Requires a valid session — does NOT require step-up reauth (the user
 * is the one driving the change, not an admin).
 */
const { withApi } = require('../../../lib/api-auth');
const { initializeFirebase, getFirestoreDB } = require('../../../lib/firebase-admin');
const { invalidateUser } = require('../../../lib/api-auth');
const admin = require('firebase-admin');
const { logAudit } = require('../../../lib/audit-log');

function validatePassword(pw) {
  if (!pw || typeof pw !== 'string') return 'Password is required.';
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter.';
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter.';
  if (!/[0-9]/.test(pw)) return 'Password must contain a digit.';
  return null;
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const caller = req.user;
  const { newPassword } = req.body || {};
  const err = validatePassword(newPassword);
  if (err) return res.status(400).json({ error: err });

  initializeFirebase();
  const db = getFirestoreDB();

  let authUser;
  try {
    authUser = await admin.auth().getUserByEmail(caller.email);
  } catch (e) {
    return res.status(404).json({ error: 'User not found' });
  }

  await admin.auth().updateUser(authUser.uid, { password: newPassword });

  await db.collection('dashboard_users').doc(caller.email).set({
    mustChangePassword: false,
    passwordChangedAt: admin.firestore.FieldValue.serverTimestamp(),
    // Force any other live sessions (e.g. mobile) to re-auth.
    tokenValidAfter: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  invalidateUser(caller.email);

  try {
    await logAudit(db, {
      actor: caller, req,
      kind: 'user.password_changed',
      target: { type: 'user', id: caller.email, label: caller.name || caller.email },
      summary: `${caller.email} changed their own password`,
    });
  } catch {}

  return res.status(200).json({ ok: true });
}

module.exports = withApi(handler, { requireUser: true });
module.exports.default = module.exports;
