/**
 * POST /api/auth/users/[email]/reissue-otp
 *
 * Mint a fresh one-time password for an existing user and email it to
 * them. Used when a user forgets their temporary password before the
 * forced first-login change. Requires step-up reauth from the admin —
 * this is the only password-related write that bypasses user consent.
 *
 * Side-effects:
 *   - Firebase Auth password rotated
 *   - Firestore: mustChangePassword=true, lastOtpIssuedAt/By stamped
 *   - Audit log entry kind=user.reissue_otp
 */
const { withApi } = require('../../../../../lib/api-auth');
const { initializeFirebase, getFirestoreDB } = require('../../../../../lib/firebase-admin');
const admin = require('firebase-admin');
const { generateOtp } = require('../../../../../lib/otp');
const { sendEmail } = require('../../../../../lib/email');
const { renderInviteEmail } = require('../../../../../lib/email-templates');
const { logAudit } = require('../../../../../lib/audit-log');
const { invalidateUser } = require('../../../../../lib/api-auth');

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const caller = req.user;
  const rawEmail = req.query.email;
  if (!rawEmail || typeof rawEmail !== 'string') {
    return res.status(400).json({ error: 'Email required' });
  }
  const email = rawEmail.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  initializeFirebase();
  const db = getFirestoreDB();
  const userRef = db.collection('dashboard_users').doc(email);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    return res.status(404).json({ error: 'User not found' });
  }
  const userData = userSnap.data() || {};

  // Owners and admins protect each other — only an owner may rotate
  // an owner/admin password to avoid privilege-escalation surprises.
  if (['owner', 'admin'].includes(userData.role) && caller.role !== 'owner') {
    return res.status(403).json({ error: 'Only owners can re-issue OTP for owner/admin accounts.' });
  }

  let authUser;
  try {
    authUser = await admin.auth().getUserByEmail(email);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      return res.status(404).json({ error: 'Firebase Auth user does not exist' });
    }
    throw err;
  }

  const newOtp = generateOtp(12);
  await admin.auth().updateUser(authUser.uid, { password: newOtp });

  const loginUrl = process.env.INVITE_LOGIN_URL
    || (req.headers?.origin ? `${req.headers.origin}/login` : 'https://binus-simprug-pickup.vercel.app/login');
  const tpl = renderInviteEmail({
    name: userData.name || email,
    email,
    otp: newOtp,
    loginUrl,
    role: userData.role || 'viewer',
    invitedBy: caller.name || caller.email,
  });
  const sendResult = await sendEmail({
    to: email,
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  });
  if (!sendResult.ok) {
    // Password is already rotated — at this point the user is locked out
    // until the admin retries or hands them the OTP another way.
    console.error('[reissue-otp] email failed:', sendResult.error);
    return res.status(502).json({
      error: 'invite_email_failed',
      message: `Password was rotated but email could not be delivered: ${sendResult.error}`,
    });
  }

  await userRef.set({
    mustChangePassword: true,
    lastOtpIssuedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastOtpIssuedBy: caller.email,
    // Bump tokenValidAfter so any existing sessions are forced to re-auth.
    tokenValidAfter: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  invalidateUser(email);

  try {
    await logAudit(db, {
      actor: caller, req,
      kind: 'user.reissue_otp',
      target: { type: 'user', id: email, label: userData.name || email },
      summary: `Re-issued temporary password for ${email}`,
    });
  } catch {}

  return res.status(200).json({ ok: true });
}

module.exports = withApi(handler, { permission: 'user_management.edit', reauth: true });
module.exports.default = module.exports;
