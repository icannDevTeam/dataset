/**
 * lib/email-templates.js — Branded HTML email renderers.
 *
 * Templates use inline styles only — every major mail client strips
 * <style> tags or processes them inconsistently. Width capped at 560px
 * for Gmail's preview pane. Plain-text fallback is generated alongside
 * for clients that won't render HTML and for inbox preview lines.
 */

const BRAND_NAVY = '#0F2A4D';
const BRAND_GOLD = '#FFC107';
const BORDER = '#E5E7EB';
const TEXT_DARK = '#111827';
const TEXT_MUTED = '#4B5563';
const SURFACE = '#F9FAFB';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Invite email — sent to a newly created user (or via "re-issue OTP").
 *
 * @param {object} opts
 * @param {string} opts.name        — user display name
 * @param {string} opts.email       — login email (also recipient)
 * @param {string} opts.otp         — one-time password
 * @param {string} opts.loginUrl    — full URL to the login page
 * @param {string} opts.role        — assigned role (admin/teacher/etc)
 * @param {string} [opts.invitedBy] — admin who issued the invite
 * @returns {{subject:string, html:string, text:string}}
 */
function renderInviteEmail({ name, email, otp, loginUrl, role, invitedBy }) {
  const safeName = escapeHtml(name || email);
  const safeEmail = escapeHtml(email);
  const safeOtp = escapeHtml(otp);
  const safeRole = escapeHtml(role || 'user');
  const safeLogin = escapeHtml(loginUrl);
  const safeInviter = invitedBy ? escapeHtml(invitedBy) : null;
  const subject = 'Your BINUS Simprug Pickup System login';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${SURFACE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT_DARK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
        <tr><td style="background:${BRAND_NAVY};padding:24px 28px;color:#ffffff;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BRAND_GOLD};font-weight:700;">BINUS Simprug</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">Pickup System Account Created</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${TEXT_DARK};">
            Hi <strong>${safeName}</strong>,
          </p>
          <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:${TEXT_MUTED};">
            ${safeInviter ? `${safeInviter} has` : 'An administrator has'} created an account
            for you in the BINUS Simprug Pickup System with the role
            <strong style="color:${TEXT_DARK};">${safeRole}</strong>.
            Use the temporary password below to sign in.
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;">
            <tr><td style="background:${SURFACE};border:1px solid ${BORDER};border-radius:10px;padding:18px;text-align:center;">
              <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${TEXT_MUTED};font-weight:700;">Temporary Password</div>
              <div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:2px;color:${BRAND_NAVY};margin-top:10px;word-break:break-all;">${safeOtp}</div>
              <div style="font-size:11px;color:${TEXT_MUTED};margin-top:10px;">Sign-in email: <strong style="color:${TEXT_DARK};">${safeEmail}</strong></div>
            </td></tr>
          </table>

          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 22px;">
            <tr><td style="background:${BRAND_NAVY};border-radius:8px;">
              <a href="${safeLogin}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">Sign in to your account →</a>
            </td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
            <tr><td style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:8px;padding:12px 14px;">
              <div style="font-size:13px;color:#78350F;line-height:1.55;">
                <strong>Important:</strong> You will be required to change this
                password the first time you sign in. The temporary password
                above will stop working as soon as you set a new one.
              </div>
            </td></tr>
          </table>

          <p style="margin:0 0 8px;font-size:13px;color:${TEXT_MUTED};line-height:1.6;">
            <strong>Forgot your password later?</strong> Use the
            "Forgot password?" link on the sign-in page to reset it
            yourself via email.
          </p>
          <p style="margin:0;font-size:12px;color:${TEXT_MUTED};line-height:1.55;">
            If you didn't expect this email, simply ignore it — without the
            password above no one can sign in to the account.
          </p>
        </td></tr>
        <tr><td style="background:${SURFACE};border-top:1px solid ${BORDER};padding:14px 28px;font-size:11px;color:${TEXT_MUTED};text-align:center;">
          BINUS Simprug · Pickup System · This is an automated message
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `Hi ${name || email},`,
    '',
    `${invitedBy || 'An administrator'} has created an account for you in the BINUS Simprug Pickup System with the role "${role || 'user'}".`,
    '',
    'Sign-in email: ' + email,
    'Temporary password: ' + otp,
    '',
    'Sign in: ' + loginUrl,
    '',
    'IMPORTANT: You will be required to change this password the first time you sign in. The temporary password above will stop working as soon as you set a new one.',
    '',
    'If you forget your password later, use the "Forgot password?" link on the sign-in page to reset it yourself.',
    '',
    'If you did not expect this email, simply ignore it.',
    '',
    '— BINUS Simprug Pickup System',
  ].join('\n');

  return { subject, html, text };
}

/**
 * Onboarding confirmation email — sent to the guardian immediately after a
 * successful pickup form submission. Purely informational; no links/actions.
 *
 * @param {object} opts
 * @param {string} opts.guardianName
 * @param {string} opts.formNumber   — e.g. PKP-2026-00003
 * @param {string} opts.submittedAt  — ISO timestamp
 * @param {string[]} opts.studentNames
 * @returns {{subject:string, html:string, text:string}}
 */
function renderOnboardingConfirmationEmail({ guardianName, formNumber, submittedAt, studentNames }) {
  const safeName = escapeHtml(guardianName);
  const safeForm = escapeHtml(formNumber);
  const safeDate = escapeHtml(new Date(submittedAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'long', timeStyle: 'short' }));
  const safeStudents = (studentNames || []).map(escapeHtml);
  const subject = `Pickup form received: ${formNumber}`;

  const studentListHtml = safeStudents.length
    ? `<ul style="margin:6px 0 0;padding-left:20px;">${safeStudents.map((n) => `<li style="font-size:14px;color:${TEXT_DARK};line-height:1.8;">${n}</li>`).join('')}</ul>`
    : `<p style="margin:6px 0 0;font-size:14px;color:${TEXT_MUTED};">No student details provided.</p>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${SURFACE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT_DARK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
        <tr><td style="background:${BRAND_NAVY};padding:24px 28px;color:#ffffff;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BRAND_GOLD};font-weight:700;">BINUS Simprug</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">Your pickup form has been received</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${TEXT_DARK};">
            Hi <strong>${safeName}</strong>,
          </p>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:${TEXT_MUTED};">
            Thank you for submitting your BINUS School Simprug pickup authorization form. Our team has received it and will review it next.
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
            <tr><td style="background:${SURFACE};border:1px solid ${BORDER};border-radius:10px;padding:16px 18px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${TEXT_MUTED};font-weight:700;padding-bottom:4px;">Form Number</td>
                </tr>
                <tr>
                  <td style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:22px;font-weight:700;color:${BRAND_NAVY};letter-spacing:1px;">${safeForm}</td>
                </tr>
                <tr>
                  <td style="font-size:12px;color:${TEXT_MUTED};padding-top:6px;">Submitted: ${safeDate} WIB</td>
                </tr>
              </table>
            </td></tr>
          </table>

          <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:${TEXT_DARK};">Student(s) registered:</p>
          ${studentListHtml}

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;">
            <tr><td style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:12px 14px;">
              <div style="font-size:13px;color:#1E40AF;line-height:1.6;">
                <strong>Need to make changes?</strong><br>
                Please visit the <strong>ACOP office on the 3rd floor</strong> or email
                <a href="mailto:inquiries.simprug@binus.edu" style="color:#1D4ED8;">inquiries.simprug@binus.edu</a>.
                Please include your form number <strong>${safeForm}</strong> when you contact us.
              </div>
            </td></tr>
          </table>

          <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:${TEXT_MUTED};">
            This is a confirmation only. You do not need to reply to this email.
          </p>
        </td></tr>
        <tr><td style="background:${SURFACE};border-top:1px solid ${BORDER};padding:14px 28px;font-size:11px;color:${TEXT_MUTED};text-align:center;">
          BINUS Simprug · Pickup System · This is an automated message — please do not reply
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const studentListText = (studentNames || []).map((n) => `  • ${n}`).join('\n') || '  (none)';

  const text = [
    `Hi ${guardianName},`,
    '',
    'Thank you for submitting your BINUS School Simprug pickup authorization form. Our team has received it and will review it next.',
    '',
    `Form number : ${formNumber}`,
    `Submitted   : ${safeDate} WIB`,
    '',
    'Registered student(s):',
    studentListText,
    '',
    'Need to make changes? Please visit the ACOP office on the 3rd floor or email inquiries.simprug@binus.edu.',
    `Please include your form number ${formNumber} when you contact us.`,
    '',
    'This is a confirmation only. You do not need to reply to this email.',
    '',
    '— BINUS Simprug Pickup System',
  ].join('\n');

  return { subject, html, text };
}

/**
 * Password reset email — sent when a user requests a self-service reset.
 *
 * @param {object} opts
 * @param {string} opts.name        — user display name
 * @param {string} opts.email       — login email (also recipient)
 * @param {string} opts.resetUrl    — full URL to the reset page (with token)
 * @param {number} opts.ttlMinutes  — link lifetime shown in copy
 * @returns {{subject:string, html:string, text:string}}
 */
function renderPasswordResetEmail({ name, email, resetUrl, ttlMinutes = 30 }) {
  const safeName = escapeHtml(name || email);
  const safeEmail = escapeHtml(email);
  const safeUrl = escapeHtml(resetUrl);
  const subject = 'Reset your BINUS Simprug Pickup System password';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${SURFACE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT_DARK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
        <tr><td style="background:${BRAND_NAVY};padding:24px 28px;color:#ffffff;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BRAND_GOLD};font-weight:700;">BINUS Simprug</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">Password Reset Request</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${TEXT_DARK};">
            Hi <strong>${safeName}</strong>,
          </p>
          <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:${TEXT_MUTED};">
            We received a request to reset the password for
            <strong style="color:${TEXT_DARK};">${safeEmail}</strong>.
            Click the button below to choose a new password.
          </p>

          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 22px;">
            <tr><td style="background:${BRAND_NAVY};border-radius:8px;">
              <a href="${safeUrl}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">Reset your password →</a>
            </td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
            <tr><td style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:8px;padding:12px 14px;">
              <div style="font-size:13px;color:#78350F;line-height:1.55;">
                <strong>This link expires in ${Number(ttlMinutes)} minutes</strong>
                and can only be used once. If it expires, simply request a
                new one from the sign-in page.
              </div>
            </td></tr>
          </table>

          <p style="margin:0;font-size:12px;color:${TEXT_MUTED};line-height:1.55;">
            If you didn't request this, you can safely ignore this email —
            your password has not been changed and the link will expire on
            its own.
          </p>
        </td></tr>
        <tr><td style="background:${SURFACE};border-top:1px solid ${BORDER};padding:14px 28px;font-size:11px;color:${TEXT_MUTED};text-align:center;">
          BINUS Simprug · Pickup System · This is an automated message
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `Hi ${name || email},`,
    '',
    `We received a request to reset the password for ${email}.`,
    '',
    'Reset your password: ' + resetUrl,
    '',
    `This link expires in ${Number(ttlMinutes)} minutes and can only be used once. If it expires, request a new one from the sign-in page.`,
    '',
    "If you didn't request this, ignore this email — your password has not been changed.",
    '',
    '— BINUS Simprug Pickup System',
  ].join('\n');

  return { subject, html, text };
}

/**
 * Password changed notification — sent after a successful self-service reset.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.email
 * @returns {{subject:string, html:string, text:string}}
 */
function renderPasswordChangedEmail({ name, email }) {
  const safeName = escapeHtml(name || email);
  const safeEmail = escapeHtml(email);
  const changedAt = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'long', timeStyle: 'short' });
  const subject = 'Your BINUS Simprug Pickup System password was changed';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:${SURFACE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${TEXT_DARK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SURFACE};padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
        <tr><td style="background:${BRAND_NAVY};padding:24px 28px;color:#ffffff;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${BRAND_GOLD};font-weight:700;">BINUS Simprug</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">Password Changed</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${TEXT_DARK};">
            Hi <strong>${safeName}</strong>,
          </p>
          <p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:${TEXT_MUTED};">
            The password for <strong style="color:${TEXT_DARK};">${safeEmail}</strong>
            was changed on ${escapeHtml(changedAt)} WIB using the password
            reset link. All other sessions have been signed out.
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
            <tr><td style="background:#FEE2E2;border:1px solid #FCA5A5;border-radius:8px;padding:12px 14px;">
              <div style="font-size:13px;color:#7F1D1D;line-height:1.55;">
                <strong>Wasn't you?</strong> Contact your system administrator
                immediately so they can suspend the account and issue a new
                temporary password.
              </div>
            </td></tr>
          </table>

          <p style="margin:0;font-size:12px;color:${TEXT_MUTED};line-height:1.55;">
            If you made this change, no further action is needed.
          </p>
        </td></tr>
        <tr><td style="background:${SURFACE};border-top:1px solid ${BORDER};padding:14px 28px;font-size:11px;color:${TEXT_MUTED};text-align:center;">
          BINUS Simprug · Pickup System · This is an automated message
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `Hi ${name || email},`,
    '',
    `The password for ${email} was changed on ${changedAt} WIB using the password reset link. All other sessions have been signed out.`,
    '',
    "WASN'T YOU? Contact your system administrator immediately so they can suspend the account and issue a new temporary password.",
    '',
    'If you made this change, no further action is needed.',
    '',
    '— BINUS Simprug Pickup System',
  ].join('\n');

  return { subject, html, text };
}

module.exports = {
  renderInviteEmail,
  renderOnboardingConfirmationEmail,
  renderPasswordResetEmail,
  renderPasswordChangedEmail,
};
