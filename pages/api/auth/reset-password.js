/**
 * POST /api/auth/reset-password — public, rate-limited.
 *
 * Body: { token: string, newPassword: string }
 *
 * Verifies a signed single-use reset token (see lib/password-reset-token.js),
 * then rotates the Firebase Auth password. Consumption happens inside a
 * Firestore transaction: the token's `tva` claim must equal the user's
 * current tokenValidAfter; the transaction bumps it, which both prevents
 * replay/concurrent redeem and force-logs-out every existing session.
 *
 * Errors: link_invalid | link_expired | link_used | weak password message.
 */
const admin = require('firebase-admin');
const { initializeFirebase, getFirestoreDB } = require('../../../lib/firebase-admin');
const { invalidateUser } = require('../../../lib/api-auth');
const { enforceRateLimit, clientIp } = require('../../../lib/rate-limit');
const { inspectPasswordResetToken } = require('../../../lib/password-reset-token');
const { validatePassword } = require('../../../lib/password-policy');
const { sendEmail } = require('../../../lib/email');
const { renderPasswordChangedEmail } = require('../../../lib/email-templates');
const { logAudit } = require('../../../lib/audit-log');

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const limit = enforceRateLimit('auth:reset-password-ip', clientIp(req), { max: 10, windowMs: 15 * 60_000 });
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({ error: 'rate_limited', retryAfter: limit.retryAfter });
  }

  const { token, newPassword } = req.body || {};

  const pwError = validatePassword(newPassword);
  if (pwError) return res.status(400).json({ error: pwError });

  const inspected = inspectPasswordResetToken(token);
  if (!inspected.ok) {
    if (inspected.reason === 'expired') return res.status(400).json({ error: 'link_expired' });
    return res.status(400).json({ error: 'link_invalid' });
  }
  const { em: email, tva } = inspected.claims;

  initializeFirebase();
  const db = getFirestoreDB();
  const userRef = db.collection('dashboard_users').doc(email);

  // Consume the token: tva must match the live doc, then bump it.
  try {
    await db.runTransaction(async (txn) => {
      const snap = await txn.get(userRef);
      if (!snap.exists) { const e = new Error('link_invalid'); e.code = 'link_invalid'; throw e; }
      const data = snap.data() || {};
      if (data.disabled === true) { const e = new Error('link_invalid'); e.code = 'link_invalid'; throw e; }
      const currentTva = data.tokenValidAfter?.toMillis?.() || 0;
      if (currentTva !== tva) { const e = new Error('link_used'); e.code = 'link_used'; throw e; }
      txn.set(userRef, {
        tokenValidAfter: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
  } catch (err) {
    if (err?.code === 'link_invalid' || err?.code === 'link_used') {
      return res.status(400).json({ error: err.code });
    }
    console.error('[reset-password] transaction failed:', err?.message);
    return res.status(500).json({ error: 'internal' });
  }

  // Token consumed — rotate the Firebase Auth password. If this fails the
  // link is already dead (fail-closed); the user requests a fresh one.
  let authUser;
  try {
    authUser = await admin.auth().getUserByEmail(email);
    await admin.auth().updateUser(authUser.uid, { password: newPassword });
    await admin.auth().revokeRefreshTokens(authUser.uid);
  } catch (err) {
    if (err?.code === 'auth/user-not-found') return res.status(400).json({ error: 'link_invalid' });
    console.error('[reset-password] password rotation failed:', err?.message);
    return res.status(500).json({ error: 'internal', message: 'Password update failed — please request a new reset link.' });
  }

  let userData = {};
  try {
    await userRef.set({
      mustChangePassword: false,
      passwordChangedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    const fresh = await userRef.get();
    userData = fresh.data() || {};
  } catch {}
  invalidateUser(email);

  try {
    await logAudit(db, {
      actor: { email, name: userData.name || email },
      req,
      kind: 'user.password_reset',
      target: { type: 'user', id: email, label: userData.name || email },
      summary: `${email} reset their password via email link`,
      metadata: { source: 'self-service' },
    });
  } catch {}

  // Best-effort security notification.
  try {
    const tpl = renderPasswordChangedEmail({ name: userData.name || email, email });
    await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
  } catch (err) {
    console.error('[reset-password] confirmation email failed:', err?.message);
  }

  return res.status(200).json({ ok: true });
}

module.exports = handler;
module.exports.default = handler;
