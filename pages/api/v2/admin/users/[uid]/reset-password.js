/**
 * /api/v2/admin/users/[uid]/reset-password — Owner/Admin password reset.
 *
 * SECURITY MODEL
 *   - withApi: enforces auth + CSRF + sensitive_user_access.reset_user_password
 *     permission gate + 5 req/min/IP rate limit.
 *   - verifyReauth(maxAgeSec=120): caller must have re-entered their own
 *     password within the past 2 minutes (X-Reauth-Token header). This
 *     defeats stolen-cookie + leave-laptop-open attacks for the most
 *     destructive admin capability.
 *   - Server-side password policy: identical to the client-side rules so a
 *     manipulated browser cannot ship a weak password.
 *   - Self-reset block: an admin cannot use this endpoint to reset their
 *     OWN password (use /api/auth/change-password instead). req.user does
 *     NOT carry a uid, so we compare the resolved Auth user's email to
 *     req.user.email.
 *   - The new password is NEVER logged. The audit entry records only
 *     metadata (target uid + actor email). The password value is held in
 *     memory only for the Admin SDK updateUser call.
 *   - All sessions for the reset user are revoked immediately so any
 *     active attacker session is severed.
 */
import { withApi } from '../../../../../../lib/api-auth';
import { verifyReauth } from '../../../../../../lib/reauth';
import { initializeFirebase, getFirebaseAdmin, getFirestoreDB } from '../../../../../../lib/firebase-admin';
import { logAudit } from '../../../../../../lib/audit-log';
import { getTenantId } from '../../../../../../lib/tenancy';

// Server-side mirror of the client's password rules. MUST stay in sync.
function validatePassword(pw) {
  if (typeof pw !== 'string') return { ok: false, reason: 'must_be_string' };
  if (pw.length < 12) return { ok: false, reason: 'min_length' };
  if (!/[A-Z]/.test(pw)) return { ok: false, reason: 'missing_upper' };
  if (!/[a-z]/.test(pw)) return { ok: false, reason: 'missing_lower' };
  if (!/[0-9]/.test(pw)) return { ok: false, reason: 'missing_digit' };
  // Match any non-alphanumeric, non-whitespace character as "symbol".
  if (!/[^A-Za-z0-9\s]/.test(pw)) return { ok: false, reason: 'missing_symbol' };
  if (/\s/.test(pw)) return { ok: false, reason: 'whitespace_not_allowed' };
  return { ok: true };
}

async function handler(req, res) {
  const { uid } = req.query;
  if (!uid || typeof uid !== 'string' || uid.length > 128) {
    return res.status(400).json({ error: 'invalid_uid' });
  }

  // ── Step-up auth (sudo mode) — fresh password within 120s ──────────
  const reauth = await verifyReauth(req, { maxAgeSec: 120 });
  if (!reauth.ok) {
    const body = { error: reauth.error };
    if (reauth.message) body.message = reauth.message;
    if (reauth.retryAfterSec) {
      body.retryAfterSec = reauth.retryAfterSec;
      res.setHeader('Retry-After', reauth.retryAfterSec);
    }
    return res.status(reauth.status || 401).json(body);
  }

  const { newPassword } = req.body || {};
  const check = validatePassword(newPassword);
  if (!check.ok) {
    return res.status(400).json({ error: 'weak_password', reason: check.reason });
  }

  try {
    initializeFirebase();
  } catch (err) {
    console.error('[reset-password] firebase init failed', err.message);
    return res.status(500).json({ error: 'firebase_unavailable' });
  }
  const admin = getFirebaseAdmin();

  // Resolve target user so we can (a) confirm they exist and (b) compare
  // their email against the caller's to block self-reset.
  let targetUser;
  try {
    targetUser = await admin.auth().getUser(uid);
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') {
      return res.status(404).json({ error: 'user_not_found' });
    }
    console.error('[reset-password] getUser failed', err.message);
    return res.status(500).json({ error: 'lookup_failed' });
  }

  // Self-reset block — req.user has email but no uid in this codebase.
  const callerEmail = (req.user.email || '').toLowerCase().trim();
  const targetEmail = (targetUser.email || '').toLowerCase().trim();
  if (callerEmail && targetEmail && callerEmail === targetEmail) {
    return res.status(403).json({
      error: 'cannot_self_reset',
      message: 'Use Change Password in your account settings to reset your own password.',
    });
  }

  // Perform the password update + revoke all active sessions for the target.
  try {
    await admin.auth().updateUser(uid, { password: newPassword });
    await admin.auth().revokeRefreshTokens(uid);
  } catch (err) {
    console.error('[reset-password] updateUser failed', err.message);
    return res.status(500).json({ error: 'reset_failed' });
  }

  // Force Firestore-mirror token-invalidation so cookie sessions are nuked
  // immediately on the next request, not after the 60-second identity cache.
  try {
    const db = getFirestoreDB();
    if (targetEmail) {
      await db.collection('dashboard_users').doc(targetEmail).set(
        {
          tokenValidAfter: admin.firestore.FieldValue.serverTimestamp(),
          mustChangePassword: true,
          lastPasswordResetBy: callerEmail,
          lastPasswordResetAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  } catch (err) {
    // Non-fatal — Firebase Auth password is already updated. Surface a warn.
    console.warn('[reset-password] mirror update failed', err.message);
  }

  // High-severity audit. NEVER log the password value.
  try {
    const db = getFirestoreDB();
    const tenantId = getTenantId();
    await logAudit(db, {
      tenantId,
      actor: req.user,
      kind: 'user.password_reset_by_admin',
      target: { type: 'user', id: uid, label: targetEmail || uid },
      summary: `Admin reset password for ${targetEmail || uid}`,
      metadata: {
        targetUid: uid,
        targetEmail: targetEmail || null,
        severity: 'high',
        reauthAgeSec: reauth.ageSec ?? null,
      },
      req,
    });
  } catch (err) {
    console.error('[reset-password] audit log failed', err.message);
    // Do NOT fail the request — password is already reset. Audit failures
    // are surfaced via console.error and infra alerting.
  }

  return res.status(200).json({ ok: true });
}

export default withApi(handler, {
  methods: ['POST'],
  permission: 'sensitive_user_access.reset_user_password',
  rateLimit: 5,
});
