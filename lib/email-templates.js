/**
 * lib/email-templates.js — Branded HTML email renderers.
 *
 * Layout follows the "Spry" transactional template: light-blue page,
 * small centered logo, lavender hero panel with logo + tagline, white
 * body card with left-aligned heading, centered purple CTA button,
 * team sign-off, and a thin footer strip.
 *
 * Inline styles only — every major mail client strips <style> tags or
 * processes them inconsistently. Plain-text fallback is generated
 * alongside for clients that won't render HTML.
 */

const PAGE_BG = '#EEF2FA';
const HERO_BG = '#E4EAF8';
const BUTTON_BG = '#6C68D5';
const HEADING = '#3B3F49';
const BODY_TEXT = '#5A6472';
const MUTED = '#8A93A2';
const BORDER = '#E5E7EB';
const SURFACE = '#F7F9FC';
const LOGO_URL = 'https://dataset-sigma.vercel.app/binus-logo.jpg';
const TAGLINE = 'Secure student pickup &amp; attendance system for BINUS School Simprug.';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Shared Spry-style shell.
 *
 * @param {object} opts
 * @param {string} opts.title        — <title> / preheader
 * @param {string} opts.heading      — bold card heading ("Welcome, Jane!")
 * @param {string} opts.bodyHtml     — pre-escaped HTML for the card body
 * @param {{label:string, url:string}} [opts.button] — centered CTA
 * @param {string} [opts.footnoteHtml] — small gray text under the sign-off
 */
function renderBase({ title, heading, bodyHtml, button, footnoteHtml }) {
  const buttonHtml = button ? `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0;">
              <tr><td align="center">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr><td style="background:${BUTTON_BG};border-radius:6px;">
                    <a href="${escapeHtml(button.url)}" style="display:inline-block;padding:14px 56px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:0.3px;">${escapeHtml(button.label)}</a>
                  </td></tr>
                </table>
              </td></tr>
            </table>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${PAGE_BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${HEADING};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};padding:32px 16px 48px;">
    <tr><td align="center" style="padding-bottom:24px;">
      <img src="${LOGO_URL}" alt="BINUS" width="44" height="44" style="display:block;border-radius:8px;">
    </td></tr>
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">

        <tr><td style="background:${HERO_BG};padding:36px 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td valign="middle" style="width:64px;">
                <img src="${LOGO_URL}" alt="BINUS" width="56" height="56" style="display:block;border-radius:10px;">
              </td>
              <td valign="middle" style="padding-left:18px;">
                <div style="font-size:18px;font-weight:700;color:${HEADING};letter-spacing:0.2px;">BINUS Simprug <span style="color:${BUTTON_BG};">Pickup</span></div>
                <div style="font-size:13px;color:${BODY_TEXT};line-height:1.6;margin-top:4px;">${TAGLINE}</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <tr><td style="background:#ffffff;padding:36px 40px;">
          <h2 style="margin:0 0 16px;font-size:22px;font-weight:700;color:${HEADING};">${heading}</h2>
          ${bodyHtml}
          ${buttonHtml}
          <p style="margin:28px 0 0;font-size:14px;font-weight:700;color:${HEADING};">The BINUS Simprug Pickup Team.</p>
          ${footnoteHtml ? `<p style="margin:14px 0 0;font-size:12px;color:${MUTED};line-height:1.6;">${footnoteHtml}</p>` : ''}
        </td></tr>

        <tr><td style="background:${HERO_BG};padding:30px 40px;text-align:center;">
          <img src="${LOGO_URL}" alt="BINUS School Simprug" width="84" height="84" style="display:inline-block;border-radius:12px;">
          <div style="margin-top:14px;font-size:11px;letter-spacing:4px;text-transform:uppercase;color:${BUTTON_BG};font-weight:700;">Binus Spirit</div>
          <div style="margin-top:10px;font-size:12.5px;color:${BODY_TEXT};line-height:1.9;">
            <strong style="color:${BUTTON_BG};">S</strong>triving for Excellence&nbsp;&nbsp;·&nbsp;&nbsp;<strong style="color:${BUTTON_BG};">P</strong>erseverance&nbsp;&nbsp;·&nbsp;&nbsp;<strong style="color:${BUTTON_BG};">I</strong>ntegrity<br>
            <strong style="color:${BUTTON_BG};">R</strong>espect&nbsp;&nbsp;·&nbsp;&nbsp;<strong style="color:${BUTTON_BG};">I</strong>nnovation&nbsp;&nbsp;·&nbsp;&nbsp;<strong style="color:${BUTTON_BG};">T</strong>eamwork
          </div>
          <div style="margin-top:14px;font-size:11px;color:${MUTED};font-style:italic;">People &nbsp;·&nbsp; Innovation &nbsp;·&nbsp; Excellence</div>
        </td></tr>

        <tr><td style="background:${BUTTON_BG};height:6px;font-size:0;line-height:0;">&nbsp;</td></tr>

        <tr><td style="padding:18px 8px 0;text-align:center;font-size:11px;color:${MUTED};">
          BINUS School Simprug · Pickup System · This is an automated message
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
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
  const safeInviter = invitedBy ? escapeHtml(invitedBy) : null;
  const subject = 'Your BINUS Simprug Pickup System login';

  const bodyHtml = `
          <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:${BODY_TEXT};">
            ${safeInviter ? `${safeInviter} has` : 'An administrator has'} created an account
            for you in the <a href="${escapeHtml(loginUrl)}" style="color:${BUTTON_BG};">BINUS Simprug Pickup System</a>
            with the role <strong style="color:${HEADING};">${safeRole}</strong>.
            Use the temporary password below to sign in.
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;">
            <tr><td style="background:${SURFACE};border:1px solid ${BORDER};border-radius:8px;padding:18px;text-align:center;">
              <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${MUTED};font-weight:700;">Temporary Password</div>
              <div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:24px;font-weight:700;letter-spacing:2px;color:${BUTTON_BG};margin-top:10px;word-break:break-all;">${safeOtp}</div>
              <div style="font-size:11px;color:${MUTED};margin-top:10px;">Sign-in email: <strong style="color:${HEADING};">${safeEmail}</strong></div>
            </td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:8px;padding:12px 14px;">
              <div style="font-size:13px;color:#78350F;line-height:1.55;">
                <strong>Important:</strong> You will be required to change this
                password the first time you sign in. The temporary password
                above will stop working as soon as you set a new one.
              </div>
            </td></tr>
          </table>`;

  const html = renderBase({
    title: subject,
    heading: `Welcome, ${safeName}!`,
    bodyHtml,
    button: { label: 'Login', url: loginUrl },
    footnoteHtml: `Forgot your password later? Use the &quot;Forgot password?&quot; link on the sign-in page to reset it yourself via email. If you didn&#39;t expect this email, simply ignore it — without the password above no one can sign in to the account.`,
  });

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
    ? `<ul style="margin:6px 0 0;padding-left:20px;">${safeStudents.map((n) => `<li style="font-size:14px;color:${HEADING};line-height:1.8;">${n}</li>`).join('')}</ul>`
    : `<p style="margin:6px 0 0;font-size:14px;color:${MUTED};">No student details provided.</p>`;

  const bodyHtml = `
          <p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:${BODY_TEXT};">
            Thank you for submitting your BINUS School Simprug pickup
            authorization form. Our team has received it and will review it next.
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
            <tr><td style="background:${SURFACE};border:1px solid ${BORDER};border-radius:8px;padding:16px 18px;">
              <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:${MUTED};font-weight:700;padding-bottom:4px;">Form Number</div>
              <div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:22px;font-weight:700;color:${BUTTON_BG};letter-spacing:1px;">${safeForm}</div>
              <div style="font-size:12px;color:${MUTED};padding-top:6px;">Submitted: ${safeDate} WIB</div>
            </td></tr>
          </table>

          <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:${HEADING};">Student(s) registered:</p>
          ${studentListHtml}

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;">
            <tr><td style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:12px 14px;">
              <div style="font-size:13px;color:#1E40AF;line-height:1.6;">
                <strong>Need to make changes?</strong><br>
                Please visit the <strong>ACOP office on the 3rd floor</strong> or email
                <a href="mailto:inquiries.simprug@binus.edu" style="color:${BUTTON_BG};">inquiries.simprug@binus.edu</a>.
                Please include your form number <strong>${safeForm}</strong> when you contact us.
              </div>
            </td></tr>
          </table>`;

  const html = renderBase({
    title: subject,
    heading: `Thank you, ${safeName}!`,
    bodyHtml,
    footnoteHtml: 'This is a confirmation only. You do not need to reply to this email.',
  });

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
  const subject = 'Reset your BINUS Simprug Pickup System password';

  const bodyHtml = `
          <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:${BODY_TEXT};">
            We received a request to reset the password for
            <strong style="color:${HEADING};">${safeEmail}</strong>.
            Click the button below to choose a new password.
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;">
            <tr><td style="background:#FEF3C7;border:1px solid #FCD34D;border-radius:8px;padding:12px 14px;">
              <div style="font-size:13px;color:#78350F;line-height:1.55;">
                <strong>This link expires in ${Number(ttlMinutes)} minutes</strong>
                and can only be used once. If it expires, simply request a
                new one from the sign-in page.
              </div>
            </td></tr>
          </table>`;

  const html = renderBase({
    title: subject,
    heading: `Hi, ${safeName}!`,
    bodyHtml,
    button: { label: 'Reset Password', url: resetUrl },
    footnoteHtml: 'If you didn&#39;t request this, you can safely ignore this email — your password has not been changed and the link will expire on its own.',
  });

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

  const bodyHtml = `
          <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:${BODY_TEXT};">
            The password for <strong style="color:${HEADING};">${safeEmail}</strong>
            was changed on ${escapeHtml(changedAt)} WIB using the password
            reset link. All other sessions have been signed out.
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;">
            <tr><td style="background:#FEE2E2;border:1px solid #FCA5A5;border-radius:8px;padding:12px 14px;">
              <div style="font-size:13px;color:#7F1D1D;line-height:1.55;">
                <strong>Wasn&#39;t you?</strong> Contact your system administrator
                immediately so they can suspend the account and issue a new
                temporary password.
              </div>
            </td></tr>
          </table>`;

  const html = renderBase({
    title: subject,
    heading: `Hi, ${safeName}!`,
    bodyHtml,
    footnoteHtml: 'If you made this change, no further action is needed.',
  });

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
