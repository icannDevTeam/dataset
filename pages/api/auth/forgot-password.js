/**
 * POST /api/auth/forgot-password — public, rate-limited.
 *
 * Body: { email: string }
 *
 * Always answers 200 {ok:true} regardless of whether the account exists
 * (no user enumeration). When the account exists and is active, a
 * single-use 30-minute reset link is emailed via Resend.
 */
const admin = require('firebase-admin');
const { initializeFirebase, getFirestoreDB } = require('../../../lib/firebase-admin');
const { enforceRateLimit, clientIp } = require('../../../lib/rate-limit');
const { signPasswordResetToken, PASSWORD_RESET_TTL_SECONDS } = require('../../../lib/password-reset-token');
const { sendEmail } = require('../../../lib/email');
const { renderPasswordResetEmail } = require('../../../lib/email-templates');
const { logAudit } = require('../../../lib/audit-log');

const GENERIC_OK = { ok: true };

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ipLimit = enforceRateLimit('auth:forgot-password-ip', clientIp(req), { max: 5, windowMs: 15 * 60_000 });
  if (!ipLimit.allowed) {
    res.setHeader('Retry-After', String(ipLimit.retryAfter));
    return res.status(429).json({ error: 'rate_limited', retryAfter: ipLimit.retryAfter });
  }

  const rawEmail = req.body?.email;
  const email = typeof rawEmail === 'string' ? rawEmail.toLowerCase().trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // Invalid shape — still generic to keep responses uniform.
    return res.status(200).json(GENERIC_OK);
  }

  const emailLimit = enforceRateLimit('auth:forgot-password-email', email, { max: 3, windowMs: 60 * 60_000 });
  if (!emailLimit.allowed) {
    res.setHeader('Retry-After', String(emailLimit.retryAfter));
    return res.status(429).json({ error: 'rate_limited', retryAfter: emailLimit.retryAfter });
  }

  try {
    initializeFirebase();
    const db = getFirestoreDB();

    const userSnap = await db.collection('dashboard_users').doc(email).get();
    const userData = userSnap.exists ? (userSnap.data() || {}) : null;
    if (!userData || userData.disabled === true) {
      return res.status(200).json(GENERIC_OK);
    }

    try {
      await admin.auth().getUserByEmail(email);
    } catch (err) {
      if (err?.code === 'auth/user-not-found') return res.status(200).json(GENERIC_OK);
      throw err;
    }

    const tokenValidAfterMs = userData.tokenValidAfter?.toMillis?.() || 0;
    const token = signPasswordResetToken({ email, tokenValidAfterMs });

    const origin = (process.env.INVITE_LOGIN_URL || '').replace(/\/login\/?$/, '')
      || req.headers?.origin
      || 'https://binus-simprug-pickup.vercel.app';
    const resetUrl = `${origin}/reset-password?token=${encodeURIComponent(token)}`;

    const tpl = renderPasswordResetEmail({
      name: userData.name || email,
      email,
      resetUrl,
      ttlMinutes: Math.round(PASSWORD_RESET_TTL_SECONDS / 60),
    });
    const sendResult = await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    if (!sendResult.ok) {
      console.error('[forgot-password] email send failed:', sendResult.error);
    }

    try {
      await logAudit(db, {
        actor: { email, name: userData.name || email },
        req,
        kind: 'user.password_reset_requested',
        target: { type: 'user', id: email, label: userData.name || email },
        summary: `Password reset link requested for ${email}`,
        metadata: { source: 'self-service', emailSent: !!sendResult.ok },
      });
    } catch {}
  } catch (err) {
    // Never leak internals on this public route — log and answer generic.
    console.error('[forgot-password]', err?.message);
  }

  return res.status(200).json(GENERIC_OK);
}

module.exports = handler;
module.exports.default = handler;
