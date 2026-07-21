const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const { Resend } = require('resend');

admin.initializeApp();

const QUEUE_COLLECTION = 'email_queue';
const TEMPLATE_PICKUP_ONBOARDING = 'pickup_onboarding_confirmation';
const TEMPLATE_PICKUP_ONBOARDING_APPROVED = 'pickup_onboarding_approved';
const TEMPLATE_PICKUP_ONBOARDING_REJECTED = 'pickup_onboarding_rejected';
const TEMPLATE_PICKUP_BULK_CAMPAIGN = 'pickup_bulk_campaign';
const TEMPLATE_PICKUP_INVITE_LINK = 'pickup_invite_link';
const TEMPLATE_PICKUP_WEEKLY_REPORT = 'pickup_weekly_report';
const TEMPLATE_PICKUP_SECURITY_INCIDENT = 'pickup_security_incident';

const DEFAULT_TENANT_ID = 'binus-simprug';
const WEEKLY_REPORT_RECIPIENTS = ['via@binus.edu'];
const SECURITY_ALERT_RECIPIENTS = ['albertarthursub@gmail.com', 'johnchandra@binus.edu'];

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const INVITE_FROM_EMAIL = defineSecret('INVITE_FROM_EMAIL');
const INVITE_FROM_NAME = defineSecret('INVITE_FROM_NAME');
const INVITE_REPLY_TO = defineSecret('INVITE_REPLY_TO');

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function shouldSendSecurityIncidentEmail(incident = {}) {
  const metadata = incident.metadata || {};
  const source = String(incident.source || '').toLowerCase();
  const kind = String(incident.kind || '').toLowerCase();
  const service = String(incident.service || '').toLowerCase();

  if (source === 'watchdog_cron' || String(metadata.generatedBy || '').toLowerCase() === 'run-watchdog-health') {
    return false;
  }

  if (source === 'watchdog_cron') {
    // Watchdog writes this explicit marker to control email fanout.
    if (metadata.alertEmail === false) return false;

    // Recovery notifications are off by default to reduce noise.
    if (kind === 'recovery' && !parseBool(process.env.WATCHDOG_NOTIFY_RECOVERY_EMAILS, false)) {
      return false;
    }

    // Avoid secondary alert loops from queue failures unless explicitly enabled.
    if (service === 'email_queue' && !parseBool(process.env.WATCHDOG_NOTIFY_EMAIL_QUEUE_EMAILS, false)) {
      return false;
    }
  }

  return true;
}

function isEmailLike(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || '').trim());
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// Text-only BINUS SPIRIT footer — no images/logo by design.
// Keep in sync with web-dataset-collector/lib/email-templates.js (SPIRIT_FOOTER_HTML).
const SPIRIT_FOOTER_HTML = `
        <tr><td style="background:#F9FAFB;border-top:1px solid #E5E7EB;padding:20px 28px;text-align:center;">
          <div style="font-size:11px;letter-spacing:4px;text-transform:uppercase;color:#0F2A4D;font-weight:700;">Binus Spirit</div>
          <div style="margin-top:8px;font-size:12px;color:#4B5563;line-height:1.9;">
            <strong style="color:#0F2A4D;">S</strong>triving for Excellence&nbsp;&nbsp;&middot;&nbsp;&nbsp;<strong style="color:#0F2A4D;">P</strong>erseverance&nbsp;&nbsp;&middot;&nbsp;&nbsp;<strong style="color:#0F2A4D;">I</strong>ntegrity<br>
            <strong style="color:#0F2A4D;">R</strong>espect&nbsp;&nbsp;&middot;&nbsp;&nbsp;<strong style="color:#0F2A4D;">I</strong>nnovation&nbsp;&nbsp;&middot;&nbsp;&nbsp;<strong style="color:#0F2A4D;">T</strong>eamwork
          </div>
          <div style="margin-top:10px;font-size:11px;color:#6B7280;font-style:italic;">People &nbsp;&middot;&nbsp; Innovation &nbsp;&middot;&nbsp; Excellence</div>
          <div style="margin-top:12px;font-size:11px;color:#6B7280;">BINUS Simprug &middot; Pickup System &middot; This is an automated message</div>
        </td></tr>`;

function renderPickupOnboardingConfirmationEmail(data) {
  const guardianName = String(data?.guardianName || '').trim() || 'Parent/Guardian';
  const guardianEmail = String(data?.guardianEmail || '').trim();
  const guardianPhone = String(data?.guardianPhone || '').trim();
  const consentSignature = String(data?.consentSignature || '').trim();
  const formNumber = String(data?.formNumber || '').trim() || '—';
  const submittedAt = String(data?.submittedAt || '').trim();
  const studentNames = Array.isArray(data?.studentNames) ? data.studentNames : [];
  const students = Array.isArray(data?.students) ? data.students : [];
  const chaperones = Array.isArray(data?.chaperones) ? data.chaperones : [];

  const submittedLabel = submittedAt
    ? new Date(submittedAt).toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        dateStyle: 'long',
        timeStyle: 'short',
      })
    : '-';

  const safeName = escapeHtml(guardianName);
  const safeForm = escapeHtml(formNumber);
  const safeDate = escapeHtml(submittedLabel);
  const safeStudents = studentNames.map(escapeHtml);
  const relationLabel = {
    mother: 'M - Mother',
    father: 'F - Father',
    guardian: 'G - Guardian',
    driver: 'D - Driver',
  };

  const subject = `BINUS Simprug Pickup - Form ${formNumber} received`;

  const studentListHtml = safeStudents.length
    ? `<ul style="margin:6px 0 0;padding-left:20px;">${safeStudents.map((n) => `<li style="font-size:14px;line-height:1.7;">${n}</li>`).join('')}</ul>`
    : '<p style="margin:6px 0 0;font-size:14px;line-height:1.6;color:#4B5563;">No student details provided.</p>';

  const studentDetailRows = students.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border-collapse:collapse;">${students.map((s, idx) => {
      const itemName = escapeHtml(s?.name || '-');
      const itemGrade = escapeHtml(s?.gradeSelection || '-');
      const itemHomeroom = escapeHtml(s?.homeroom || '-');
      return `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #E5E7EB;font-size:13px;color:#111827;vertical-align:top;width:26px;">${idx + 1}.</td>
        <td style="padding:8px 0;border-bottom:1px solid #E5E7EB;font-size:13px;color:#111827;vertical-align:top;">
          <div style="font-weight:600;">${itemName}</div>
          <div style="margin-top:2px;color:#4B5563;">Grade: ${itemGrade} · Homeroom: ${itemHomeroom}</div>
        </td>
      </tr>`;
    }).join('')}</table>`
    : '<p style="margin:8px 0 0;font-size:13px;color:#4B5563;">No detailed student entries.</p>';

  const chaperoneRows = chaperones.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border-collapse:collapse;">${chaperones.map((c, idx) => {
      const itemName = escapeHtml(c?.name || '-');
      const rel = String(c?.relation || '').trim().toLowerCase();
      const itemRelation = escapeHtml(relationLabel[rel] || rel || '-');
      const authNames = Array.isArray(c?.authorizedStudentNames) ? c.authorizedStudentNames : [];
      const authLabel = authNames.length ? escapeHtml(authNames.join(', ')) : '-';
      return `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #E5E7EB;font-size:13px;color:#111827;vertical-align:top;width:26px;">${idx + 1}.</td>
        <td style="padding:8px 0;border-bottom:1px solid #E5E7EB;font-size:13px;color:#111827;vertical-align:top;">
          <div style="font-weight:600;">${itemName}</div>
          <div style="margin-top:2px;color:#4B5563;">Relation: ${itemRelation}</div>
          <div style="margin-top:2px;color:#4B5563;">Authorized for: ${authLabel}</div>
        </td>
      </tr>`;
    }).join('')}</table>`
    : '<p style="margin:8px 0 0;font-size:13px;color:#4B5563;">No chaperone entries.</p>';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#F9FAFB;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0F2A4D;color:#fff;padding:24px 28px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#FFC107;font-weight:700;">BINUS Simprug</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">Pickup Registration Received</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;">Hi <strong>${safeName}</strong>,</p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#4B5563;">We have received your pickup registration form. Our team will review it and follow up with you.</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
            <tr><td style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:12px 14px;">
              <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#4B5563;font-weight:700;margin-bottom:6px;">Parent details</div>
              <div style="font-size:13px;line-height:1.7;color:#111827;">
                <strong>Name:</strong> ${safeName}<br>
                <strong>Email:</strong> ${escapeHtml(guardianEmail || '-')}<br>
                <strong>Phone:</strong> ${escapeHtml(guardianPhone || '-')}
              </div>
            </td></tr>
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
            <tr><td style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:16px 18px;">
              <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#4B5563;font-weight:700;">Form Number</div>
              <div style="font-family:Menlo,Consolas,monospace;font-size:22px;font-weight:700;letter-spacing:1px;color:#0F2A4D;margin-top:8px;">${safeForm}</div>
              <div style="font-size:12px;color:#4B5563;margin-top:6px;">Submitted: ${safeDate} WIB</div>
            </td></tr>
          </table>

          <p style="margin:0 0 6px;font-size:13px;font-weight:700;">Student(s) registered:</p>
          ${studentListHtml}65 

          <p style="margin:16px 0 6px;font-size:13px;font-weight:700;">Submitted student details:</p>
          ${studentDetailRows}

          <p style="margin:16px 0 6px;font-size:13px;font-weight:700;">Authorized pickup people:</p>
          ${chaperoneRows}

          <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#4B5563;">
            <strong>Consent signature:</strong> ${escapeHtml(consentSignature || guardianName || '-')}
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;">
            <tr><td style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:12px 14px;">
              <div style="font-size:13px;line-height:1.6;color:#1E40AF;">
                <strong>Need to make changes?</strong><br>
                Please visit the <strong>ACOP office on the 3rd floor</strong> or email
                <a href="mailto:inquiries.simprug@binus.edu" style="color:#1D4ED8;">inquiries.simprug@binus.edu</a>.
                Quote your form number <strong>${safeForm}</strong> when you contact us.
              </div>
            </td></tr>
          </table>
        </td></tr>${SPIRIT_FOOTER_HTML}
      </table>
    </td></tr>
  </table>
</body></html>`;

  const studentListText = studentNames.length
    ? studentNames.map((n) => `  - ${n}`).join('\n')
    : '  (none)';

  const studentDetailText = students.length
    ? students.map((s, idx) => `  ${idx + 1}. ${(s?.name || '-')} | Grade ${s?.gradeSelection || '-'} | Homeroom ${s?.homeroom || '-'}`).join('\n')
    : '  (none)';

  const chaperoneText = chaperones.length
    ? chaperones.map((c, idx) => {
      const rel = String(c?.relation || '').trim().toLowerCase();
      const relation = relationLabel[rel] || rel || '-';
      const auth = Array.isArray(c?.authorizedStudentNames) && c.authorizedStudentNames.length
        ? c.authorizedStudentNames.join(', ')
        : '-';
      return `  ${idx + 1}. ${(c?.name || '-')} | ${relation} | Authorized for: ${auth}`;
    }).join('\n')
    : '  (none)';

  const text = [
    `Hi ${guardianName},`,
    '',
    'We have received your pickup registration form. Our team will review it and follow up with you.',
    '',
    `Form number : ${formNumber}`,
    `Submitted   : ${submittedLabel} WIB`,
    '',
    'Parent details:',
    `  Name : ${guardianName}`,
    `  Email: ${guardianEmail || '-'}`,
    `  Phone: ${guardianPhone || '-'}`,
    '',
    'Student(s) registered:',
    studentListText,
    '',
    'Submitted student details:',
    studentDetailText,
    '',
    'Authorized pickup people:',
    chaperoneText,
    '',
    `Consent signature: ${consentSignature || guardianName || '-'}`,
    '',
    'Need to make changes? Please visit the ACOP office on the 3rd floor or email inquiries.simprug@binus.edu.',
    `Quote your form number ${formNumber} when you contact us.`,
    '',
    '- BINUS Simprug Pickup System',
  ].join('\n');

  return { subject, html, text };
}

function renderPickupOnboardingApprovedEmail(data) {
  const guardianName = String(data?.guardianName || '').trim() || 'Parent/Guardian';
  const formNumber = String(data?.formNumber || '').trim() || '—';
  const approvedAt = String(data?.approvedAt || '').trim();
  const approvedBy = String(data?.approvedBy || '').trim() || 'ACOP Team';
  const students = Array.isArray(data?.students) ? data.students : [];
  const chaperones = Array.isArray(data?.chaperones) ? data.chaperones : [];

  const approvedLabel = approvedAt
    ? new Date(approvedAt).toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        dateStyle: 'long',
        timeStyle: 'short',
      })
    : '-';

  const relationLabel = {
    mother: 'M - Mother',
    father: 'F - Father',
    guardian: 'G - Guardian',
    driver: 'D - Driver',
  };

  const safeName = escapeHtml(guardianName);
  const safeForm = escapeHtml(formNumber);
  const safeApproved = escapeHtml(approvedLabel);
  const safeApprovedBy = escapeHtml(approvedBy);

  const studentRows = students.length
    ? `<ul style="margin:6px 0 0;padding-left:20px;">${students.map((s) => {
      const name = escapeHtml(s?.name || '-');
      const grade = escapeHtml(s?.gradeSelection || '-');
      const homeroom = escapeHtml(s?.homeroom || '-');
      return `<li style="font-size:14px;line-height:1.8;"><strong>${name}</strong> · Grade ${grade} · Homeroom ${homeroom}</li>`;
    }).join('')}</ul>`
    : '<p style="margin:6px 0 0;font-size:14px;line-height:1.6;color:#4B5563;">No student details provided.</p>';

  const chaperoneRows = chaperones.length
    ? `<ul style="margin:6px 0 0;padding-left:20px;">${chaperones.map((c) => {
      const name = escapeHtml(c?.name || '-');
      const rel = String(c?.relation || '').trim().toLowerCase();
      const relation = escapeHtml(relationLabel[rel] || rel || '-');
      const auth = Array.isArray(c?.authorizedStudentNames) && c.authorizedStudentNames.length
        ? escapeHtml(c.authorizedStudentNames.join(', '))
        : '-';
      return `<li style="font-size:14px;line-height:1.8;"><strong>${name}</strong> · ${relation} · Authorized for: ${auth}</li>`;
    }).join('')}</ul>`
    : '<p style="margin:6px 0 0;font-size:14px;line-height:1.6;color:#4B5563;">No chaperone details provided.</p>';

  const subject = `Pickup approved: ${formNumber}`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#F9FAFB;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0F2A4D;color:#fff;padding:24px 28px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#FFC107;font-weight:700;">BINUS Simprug</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">Pickup form approved</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;">Hi <strong>${safeName}</strong>,</p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#4B5563;">Your pickup authorization form has been approved by ACOP.</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
            <tr><td style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:16px 18px;">
              <div style="font-size:12px;color:#4B5563;line-height:1.7;">
                <strong>Form:</strong> ${safeForm}<br>
                <strong>Approved:</strong> ${safeApproved} WIB<br>
                <strong>Reviewed by:</strong> ${safeApprovedBy}
              </div>
            </td></tr>
          </table>

          <p style="margin:0 0 6px;font-size:13px;font-weight:700;">Children in this form:</p>
          ${studentRows}

          <p style="margin:16px 0 6px;font-size:13px;font-weight:700;">Authorized pickup people:</p>
          ${chaperoneRows}

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;">
            <tr><td style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:12px 14px;">
              <div style="font-size:13px;line-height:1.6;color:#1E40AF;">
                <strong>Need to make changes?</strong><br>
                Please visit the <strong>ACOP office on the 3rd floor</strong> or email
                <a href="mailto:inquiries.simprug@binus.edu" style="color:#1D4ED8;">inquiries.simprug@binus.edu</a> and quote your form number <strong>${safeForm}</strong>.
              </div>
            </td></tr>
          </table>
        </td></tr>${SPIRIT_FOOTER_HTML}
      </table>
    </td></tr>
  </table>
</body></html>`;

  const studentText = students.length
    ? students.map((s, idx) => `  ${idx + 1}. ${s?.name || '-'} | Grade ${s?.gradeSelection || '-'} | Homeroom ${s?.homeroom || '-'}`).join('\n')
    : '  (none)';
  const chaperoneText = chaperones.length
    ? chaperones.map((c, idx) => {
      const rel = String(c?.relation || '').trim().toLowerCase();
      const relation = relationLabel[rel] || rel || '-';
      const auth = Array.isArray(c?.authorizedStudentNames) && c.authorizedStudentNames.length
        ? c.authorizedStudentNames.join(', ')
        : '-';
      return `  ${idx + 1}. ${c?.name || '-'} | ${relation} | Authorized for: ${auth}`;
    }).join('\n')
    : '  (none)';

  const text = [
    `Hi ${guardianName},`,
    '',
    'Your pickup authorization form has been approved by ACOP.',
    '',
    `Form number : ${formNumber}`,
    `Approved    : ${approvedLabel} WIB`,
    `Reviewed by : ${approvedBy}`,
    '',
    'Children in this form:',
    studentText,
    '',
    'Authorized pickup people:',
    chaperoneText,
    '',
    'Need to make changes? Please visit the ACOP office on the 3rd floor or email inquiries.simprug@binus.edu.',
    `Quote your form number ${formNumber} when you contact us.`,
    '',
    '- BINUS Simprug Pickup System',
  ].join('\n');

  return { subject, html, text };
}

function renderPickupOnboardingRejectedEmail(data) {
  const guardianName = String(data?.guardianName || '').trim() || 'Parent/Guardian';
  const formNumber = String(data?.formNumber || '').trim() || '—';
  const rejectedAt = String(data?.rejectedAt || '').trim();
  const rejectedBy = String(data?.rejectedBy || '').trim() || 'ACOP Team';
  const rejectionReason = String(data?.rejectionReason || '').trim() || 'Please contact ACOP for details.';
  const students = Array.isArray(data?.students) ? data.students : [];

  const rejectedLabel = rejectedAt
    ? new Date(rejectedAt).toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        dateStyle: 'long',
        timeStyle: 'short',
      })
    : '-';

  const safeName = escapeHtml(guardianName);
  const safeForm = escapeHtml(formNumber);
  const safeRejectedAt = escapeHtml(rejectedLabel);
  const safeRejectedBy = escapeHtml(rejectedBy);
  const safeReason = escapeHtml(rejectionReason);

  const studentRows = students.length
    ? `<ul style="margin:6px 0 0;padding-left:20px;">${students.map((s) => {
      const name = escapeHtml(s?.name || '-');
      const grade = escapeHtml(s?.gradeSelection || '-');
      const homeroom = escapeHtml(s?.homeroom || '-');
      return `<li style="font-size:14px;line-height:1.8;"><strong>${name}</strong> · Grade ${grade} · Homeroom ${homeroom}</li>`;
    }).join('')}</ul>`
    : '<p style="margin:6px 0 0;font-size:14px;line-height:1.6;color:#4B5563;">No student details provided.</p>';

  const subject = `Pickup form update: ${formNumber}`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#F9FAFB;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0F2A4D;color:#fff;padding:24px 28px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#FFC107;font-weight:700;">BINUS Simprug</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">Pickup form requires update</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;">Hi <strong>${safeName}</strong>,</p>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#4B5563;">Your pickup authorization form needs revision before it can be approved.</p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
            <tr><td style="background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;padding:14px 16px;">
              <div style="font-size:12px;color:#7F1D1D;line-height:1.8;">
                <strong>Form:</strong> ${safeForm}<br>
                <strong>Reviewed:</strong> ${safeRejectedAt} WIB<br>
                <strong>Reviewed by:</strong> ${safeRejectedBy}
              </div>
              <div style="margin-top:10px;font-size:13px;color:#7F1D1D;line-height:1.6;">
                <strong>Notes from ACOP:</strong><br>${safeReason}
              </div>
            </td></tr>
          </table>

          <p style="margin:0 0 6px;font-size:13px;font-weight:700;">Children in this submission:</p>
          ${studentRows}

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 0;">
            <tr><td style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:12px 14px;">
              <div style="font-size:13px;line-height:1.6;color:#1E40AF;">
                Please visit the <strong>ACOP office on the 3rd floor</strong> or email
                <a href="mailto:inquiries.simprug@binus.edu" style="color:#1D4ED8;">inquiries.simprug@binus.edu</a>
                to update your form. Mention form number <strong>${safeForm}</strong>.
              </div>
            </td></tr>
          </table>
        </td></tr>${SPIRIT_FOOTER_HTML}
      </table>
    </td></tr>
  </table>
</body></html>`;

  const studentText = students.length
    ? students.map((s, idx) => `  ${idx + 1}. ${s?.name || '-'} | Grade ${s?.gradeSelection || '-'} | Homeroom ${s?.homeroom || '-'}`).join('\n')
    : '  (none)';

  const text = [
    `Hi ${guardianName},`,
    '',
    'Your pickup authorization form needs revision before it can be approved.',
    '',
    `Form number : ${formNumber}`,
    `Reviewed    : ${rejectedLabel} WIB`,
    `Reviewed by : ${rejectedBy}`,
    '',
    'Notes from ACOP:',
    rejectionReason,
    '',
    'Children in this submission:',
    studentText,
    '',
    'Please visit the ACOP office on the 3rd floor or email inquiries.simprug@binus.edu to update your form.',
    `Mention form number ${formNumber} when contacting us.`,
    '',
    '- BINUS Simprug Pickup System',
  ].join('\n');

  return { subject, html, text };
}

function renderPickupBulkCampaignEmail(data) {
  const subject = String(data?.subject || '').trim() || 'Pickup notice';
  const recipientName = String(data?.recipientName || '').trim() || 'Parent/Guardian';
  const studentName = String(data?.studentName || '').trim();
  const rawMessage = String(data?.message || '').trim();
  const message = rawMessage || 'Please check your pickup announcement in BINUS channels.';

  const personalized = message
    .replace(/\{name\}/g, recipientName)
    .replace(/\{studentName\}/g, studentName || 'your child');

  const safeSubject = escapeHtml(subject);
  const safeGreeting = escapeHtml(`Dear ${recipientName},`);
  const safeMessage = escapeHtml(personalized).replace(/\n/g, '<br>');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${safeSubject}</title></head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#F9FAFB;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0F2A4D;color:#fff;padding:24px 28px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#FFC107;font-weight:700;">BINUS Simprug</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">${safeSubject}</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;">${safeGreeting}</p>
          <p style="margin:0;font-size:14px;line-height:1.8;color:#374151;">${safeMessage}</p>
        </td></tr>${SPIRIT_FOOTER_HTML}
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `Dear ${recipientName},`,
    '',
    personalized,
    '',
    '- BINUS Simprug Pickup System',
  ].join('\n');

  return { subject, html, text };
}

function renderPickupInviteLinkEmail(data) {
  const recipientName = String(data?.recipientName || '').trim() || 'Parent/Guardian';
  const studentName = String(data?.studentName || '').trim();
  const inviteUrl = String(data?.inviteUrl || '').trim();
  const linkName = String(data?.linkName || '').trim() || 'Pickup Onboarding Form';
  const expiresAt = data?.expiresAt ? new Date(data.expiresAt) : null;
  const expiryText = expiresAt && !Number.isNaN(expiresAt.getTime())
    ? expiresAt.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Jakarta' }) + ' WIB'
    : '';

  const subject = 'Action needed: Register your child\u2019s pickup chaperones';
  const safeGreeting = escapeHtml(`Dear ${recipientName},`);
  const studentLine = studentName
    ? `We invite you to register the authorized pickup chaperones for <strong>${escapeHtml(studentName)}</strong>.`
    : 'We invite you to register the authorized pickup chaperones for your child.';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#F9FAFB;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0F2A4D;color:#fff;padding:24px 28px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#FFC107;font-weight:700;">BINUS Simprug</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">Student Pickup Registration</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 14px;font-size:15px;line-height:1.6;">${safeGreeting}</p>
          <p style="margin:0 0 18px;font-size:14px;line-height:1.8;color:#374151;">${studentLine} This helps us keep dismissal safe and quick \u2014 only registered chaperones may pick up students.</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 20px;">
            <tr><td style="border-radius:8px;background:#0F2A4D;">
              <a href="${escapeHtml(inviteUrl)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:700;color:#FFC107;text-decoration:none;">Open Pickup Form &rarr;</a>
            </td></tr>
          </table>
          <p style="margin:0 0 14px;font-size:12px;line-height:1.6;color:#6B7280;text-align:center;">If the button does not work, copy and paste this link:<br><a href="${escapeHtml(inviteUrl)}" style="color:#0F2A4D;word-break:break-all;">${escapeHtml(inviteUrl)}</a></p>
          ${expiryText ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;"><tr><td style="padding:12px 16px;font-size:13px;line-height:1.6;color:#92400E;"><strong>Note:</strong> This link (${escapeHtml(linkName)}) expires on ${escapeHtml(expiryText)}. Please complete the form before then.</td></tr></table>` : ''}
        </td></tr>${SPIRIT_FOOTER_HTML}
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `Dear ${recipientName},`,
    '',
    studentName
      ? `We invite you to register the authorized pickup chaperones for ${studentName}.`
      : 'We invite you to register the authorized pickup chaperones for your child.',
    'Only registered chaperones may pick up students.',
    '',
    `Open the pickup form: ${inviteUrl}`,
    expiryText ? `\nThis link (${linkName}) expires on ${expiryText}.` : '',
    '',
    '- BINUS Simprug Pickup System',
  ].filter((l) => l !== null).join('\n');

  return { subject, html, text };
}

function renderPickupWeeklyReportEmail(data) {
  const weekStart = String(data?.weekStart || '').trim();
  const weekEnd = String(data?.weekEnd || '').trim();
  const total = Number(data?.total || 0);
  const byStatus = data?.byStatus || {};
  const daily = Array.isArray(data?.daily) ? data.daily : [];
  const recent = Array.isArray(data?.recent) ? data.recent : [];

  const fmtDay = (iso) => iso
    ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric' })
    : '-';
  const rangeLabel = `${fmtDay(weekStart)} – ${fmtDay(weekEnd)}`;
  const subject = `Pickup forms weekly report: ${total} submission${total === 1 ? '' : 's'} (${rangeLabel})`;

  const statusRows = [
    ['Pending review', byStatus.pending || 0, '#B45309'],
    ['Approved', byStatus.approved || 0, '#047857'],
    ['Rejected', byStatus.rejected || 0, '#B91C1C'],
    ['Archived', byStatus.archived || 0, '#4B5563'],
  ].map(([label, n, color]) => `<tr>
    <td style="padding:8px 0;border-bottom:1px solid #E5E7EB;font-size:13px;color:#111827;">${label}</td>
    <td style="padding:8px 0;border-bottom:1px solid #E5E7EB;font-size:14px;font-weight:700;color:${color};text-align:right;">${n}</td>
  </tr>`).join('');

  const dailyRows = daily.map((d) => `<tr>
    <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;font-size:12px;color:#4B5563;">${escapeHtml(d.label || d.date || '-')}</td>
    <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;font-size:12px;font-weight:700;color:#0F2A4D;text-align:right;">${Number(d.count || 0)}</td>
  </tr>`).join('');

  const recentRows = recent.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;border-collapse:collapse;">${recent.map((r) => `<tr>
        <td style="padding:6px 0;border-bottom:1px solid #F3F4F6;font-size:12px;color:#111827;">
          <span style="font-family:Menlo,Consolas,monospace;font-weight:700;color:#0F2A4D;">${escapeHtml(r.formNumber || '-')}</span>
          &nbsp;·&nbsp;${escapeHtml(r.guardianName || '-')}
          &nbsp;·&nbsp;<span style="color:#6B7280;">${escapeHtml(r.status || '-')}</span>
        </td>
      </tr>`).join('')}</table>`
    : '<p style="margin:8px 0 0;font-size:12px;color:#6B7280;">No submissions this week.</p>';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#F9FAFB;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0F2A4D;color:#fff;padding:24px 28px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#FFC107;font-weight:700;">BINUS Simprug · Pickup System</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">Weekly Forms Report</div>
          <div style="font-size:12px;color:#CBD5E1;margin-top:4px;">${escapeHtml(rangeLabel)}</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
            <tr><td style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:10px;padding:16px 18px;text-align:center;">
              <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#4B5563;font-weight:700;">Total submissions this week</div>
              <div style="font-size:36px;font-weight:800;color:#0F2A4D;margin-top:6px;">${total}</div>
            </td></tr>
          </table>

          <p style="margin:0 0 6px;font-size:13px;font-weight:700;">By status</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px;">${statusRows}</table>

          ${dailyRows ? `<p style="margin:0 0 6px;font-size:13px;font-weight:700;">Per day</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:18px;">${dailyRows}</table>` : ''}

          <p style="margin:0 0 0;font-size:13px;font-weight:700;">Latest submissions</p>
          ${recentRows}
        </td></tr>${SPIRIT_FOOTER_HTML}
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `Pickup forms weekly report (${rangeLabel})`,
    '',
    `Total submissions: ${total}`,
    `  Pending : ${byStatus.pending || 0}`,
    `  Approved: ${byStatus.approved || 0}`,
    `  Rejected: ${byStatus.rejected || 0}`,
    `  Archived: ${byStatus.archived || 0}`,
    '',
    'Per day:',
    ...(daily.length ? daily.map((d) => `  ${d.label || d.date}: ${d.count || 0}`) : ['  (none)']),
    '',
    'Latest submissions:',
    ...(recent.length ? recent.map((r) => `  ${r.formNumber || '-'} | ${r.guardianName || '-'} | ${r.status || '-'}`) : ['  (none)']),
    '',
    '- BINUS Simprug Pickup System',
  ].join('\n');

  return { subject, html, text };
}

function renderPickupSecurityIncidentEmail(data) {
  const type = String(data?.type || data?.kind || 'security_incident').trim();
  const createdAt = String(data?.createdAt || '').trim();
  const gate = String(data?.gate || data?.terminalId || data?.source || '-').trim();
  const chaperoneName = String(data?.chaperoneName || '').trim();
  const studentName = String(data?.studentName || '').trim();
  const notes = String(data?.notes || data?.summary || '').trim();
  const eventId = String(data?.eventId || data?.incidentId || '-').trim();
  const confidence = data?.confidence != null ? Number(data.confidence) : null;
  const livenessScore = data?.livenessScore != null ? Number(data.livenessScore) : null;

  const typeLabel = {
    spoof_attempt: 'GPS / Spoof Attempt',
    liveness_failure: 'Liveness Check Failure',
    low_confidence: 'Low-Confidence Face Match',
    unknown_face: 'Unknown Face at Gate',
    officer_override: 'Officer Override',
  }[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const whenLabel = createdAt
    ? new Date(createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'long', timeStyle: 'medium' })
    : '-';

  const subject = `[SECURITY] ${typeLabel} — Pickup System`;

  const detailRows = [
    ['Incident type', typeLabel],
    ['When', `${whenLabel} WIB`],
    ['Gate / source', gate || '-'],
    chaperoneName ? ['Chaperone', chaperoneName] : null,
    studentName ? ['Student', studentName] : null,
    confidence != null && !Number.isNaN(confidence) ? ['Match confidence', `${(confidence * 100).toFixed(1)}%`] : null,
    livenessScore != null && !Number.isNaN(livenessScore) ? ['Liveness score', livenessScore.toFixed(2)] : null,
    ['Event ID', eventId],
  ].filter(Boolean).map(([k, v]) => `<tr>
    <td style="padding:7px 0;border-bottom:1px solid #FECACA;font-size:12px;color:#7F1D1D;font-weight:700;width:40%;">${escapeHtml(k)}</td>
    <td style="padding:7px 0;border-bottom:1px solid #FECACA;font-size:13px;color:#111827;">${escapeHtml(v)}</td>
  </tr>`).join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#F9FAFB;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#7F1D1D;color:#fff;padding:24px 28px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#FCA5A5;font-weight:700;">BINUS Simprug · Security Alert</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">${escapeHtml(typeLabel)}</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#4B5563;">A security incident was just recorded by the pickup system. Details below.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
            <tr><td style="background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;padding:14px 16px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${detailRows}</table>
              ${notes ? `<div style="margin-top:10px;font-size:13px;color:#7F1D1D;line-height:1.6;"><strong>Notes:</strong><br>${escapeHtml(notes)}</div>` : ''}
            </td></tr>
          </table>
          <p style="margin:0;font-size:12px;line-height:1.6;color:#6B7280;">Review this incident on the dashboard → <strong>Pickup Security</strong> page. If this looks like an active threat, contact the gate officer immediately.</p>
        </td></tr>${SPIRIT_FOOTER_HTML}
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `SECURITY ALERT — ${typeLabel}`,
    '',
    `When        : ${whenLabel} WIB`,
    `Gate/source : ${gate || '-'}`,
    chaperoneName ? `Chaperone   : ${chaperoneName}` : null,
    studentName ? `Student     : ${studentName}` : null,
    confidence != null && !Number.isNaN(confidence) ? `Confidence  : ${(confidence * 100).toFixed(1)}%` : null,
    livenessScore != null && !Number.isNaN(livenessScore) ? `Liveness    : ${livenessScore.toFixed(2)}` : null,
    `Event ID    : ${eventId}`,
    notes ? `\nNotes:\n${notes}` : null,
    '',
    'Review this incident on the dashboard (Pickup Security page).',
    '',
    '- BINUS Simprug Pickup System',
  ].filter((l) => l !== null).join('\n');

  return { subject, html, text };
}

function buildTemplate(templateType, templateData) {
  if (templateType === TEMPLATE_PICKUP_ONBOARDING) {
    return renderPickupOnboardingConfirmationEmail(templateData || {});
  }
  if (templateType === TEMPLATE_PICKUP_ONBOARDING_APPROVED) {
    return renderPickupOnboardingApprovedEmail(templateData || {});
  }
  if (templateType === TEMPLATE_PICKUP_ONBOARDING_REJECTED) {
    return renderPickupOnboardingRejectedEmail(templateData || {});
  }
  if (templateType === TEMPLATE_PICKUP_BULK_CAMPAIGN) {
    return renderPickupBulkCampaignEmail(templateData || {});
  }
  if (templateType === TEMPLATE_PICKUP_INVITE_LINK) {
    return renderPickupInviteLinkEmail(templateData || {});
  }
  if (templateType === TEMPLATE_PICKUP_WEEKLY_REPORT) {
    return renderPickupWeeklyReportEmail(templateData || {});
  }
  if (templateType === TEMPLATE_PICKUP_SECURITY_INCIDENT) {
    return renderPickupSecurityIncidentEmail(templateData || {});
  }
  return null;
}

function getResendClient() {
  const apiKey = String(RESEND_API_KEY.value() || '').trim();
  if (!apiKey) return null;
  return new Resend(apiKey);
}

exports.processEmailQueue = onDocumentCreated({
  document: `${QUEUE_COLLECTION}/{jobId}`,
  secrets: [RESEND_API_KEY, INVITE_FROM_EMAIL, INVITE_FROM_NAME, INVITE_REPLY_TO],
}, async (event) => {
  const snap = event.data;
  if (!snap) return;

  const db = admin.firestore();
  const ref = snap.ref;
  const jobId = event.params.jobId;
  const data = snap.data() || {};

  if (data.status !== 'pending') {
    logger.info('Skipping non-pending email job', { jobId, status: data.status });
    return;
  }

  const to = String(data.to || '').trim();
  const templateType = String(data.templateType || '').trim();
  const tenantId = data.tenantId || null;
  const recordId = data.recordId || null;
  const formNumber = data.formNumber || null;

  if (!to || !templateType) {
    await ref.set({
      status: 'failed',
      error: 'invalid_job_payload',
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    logger.error('Invalid email job payload', { jobId, tenantId, recordId, formNumber });
    return;
  }

  const rendered = buildTemplate(templateType, data.templateData || {});
  if (!rendered) {
    await ref.set({
      status: 'failed',
      error: 'unknown_template',
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    logger.error('Unknown email template', { jobId, templateType, tenantId, recordId, formNumber });
    return;
  }

  const client = getResendClient();
  if (!client) {
    await ref.set({
      status: 'failed',
      error: 'email_not_configured',
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    logger.error('RESEND_API_KEY missing in Cloud Functions env', { jobId, tenantId, recordId, formNumber });
    return;
  }

  const fromEmail = String(INVITE_FROM_EMAIL.value() || '').trim() || 'onboarding@resend.dev';
  const fromName = String(INVITE_FROM_NAME.value() || '').trim() || 'BINUS Simprug Pickup';
  const replyToRaw = String(INVITE_REPLY_TO.value() || '').trim();
  const includeReplyTo = isEmailLike(replyToRaw);

  const nextRetryCount = Number(data.retryCount || 0) + 1;
  const maxRetries = Number(data.maxRetries || 3);

  try {
    const payload = {
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };
    if (includeReplyTo) {
      payload.reply_to = replyToRaw;
    }

    const result = await client.emails.send(payload);

    const resendError = result?.error?.message || null;
    if (resendError) {
      const finalFailure = nextRetryCount >= maxRetries;
      await ref.set({
        status: finalFailure ? 'failed_final' : 'failed',
        error: resendError.slice(0, 500),
        retryCount: nextRetryCount,
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      logger.error('Resend API error', {
        jobId,
        tenantId,
        recordId,
        formNumber,
        retryCount: nextRetryCount,
        maxRetries,
        finalFailure,
        error: resendError,
      });
      return;
    }

    await ref.set({
      status: 'sent',
      provider: 'resend',
      providerMessageId: result?.data?.id || null,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    logger.info('Email job sent', {
      jobId,
      tenantId,
      recordId,
      formNumber,
      providerMessageId: result?.data?.id || null,
    });
  } catch (err) {
    const message = String(err?.message || 'send_failed');
    const finalFailure = nextRetryCount >= maxRetries;
    await ref.set({
      status: finalFailure ? 'failed_final' : 'failed',
      error: message.slice(0, 500),
      retryCount: nextRetryCount,
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    logger.error('Email job send exception', {
      jobId,
      tenantId,
      recordId,
      formNumber,
      retryCount: nextRetryCount,
      maxRetries,
      finalFailure,
      error: message,
    });
  }
});

function enqueueEmail(db, jobId, payload) {
  return db.collection(QUEUE_COLLECTION).doc(jobId).create({
    status: 'pending',
    retryCount: 0,
    maxRetries: 3,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...payload,
  });
}

// ─── Weekly forms-submission report (every Monday 08:00 WIB) ────────────────
exports.weeklyPickupReport = onSchedule({
  schedule: '0 8 * * 1',
  timeZone: 'Asia/Jakarta',
  region: 'asia-southeast2',
}, async () => {
  const db = admin.firestore();
  const tid = DEFAULT_TENANT_ID;
  const now = Date.now();
  const weekStartMs = now - 7 * 24 * 3600 * 1000;
  const weekStartIso = new Date(weekStartMs).toISOString();
  const weekEndIso = new Date(now).toISOString();

  const snap = await db.collection(`tenants/${tid}/pickup_onboarding`)
    .where('submittedAt', '>=', weekStartIso)
    .orderBy('submittedAt', 'desc')
    .limit(1000)
    .get();

  const byStatus = { pending: 0, approved: 0, rejected: 0, archived: 0 };
  const dayCounts = new Map();
  const recent = [];
  snap.forEach((doc) => {
    const d = doc.data();
    const s = d.status || 'pending';
    if (byStatus[s] != null) byStatus[s] += 1;
    const dayLabel = d.submittedAt
      ? new Date(d.submittedAt).toLocaleDateString('en-GB', { timeZone: 'Asia/Jakarta', weekday: 'short', day: 'numeric', month: 'short' })
      : 'unknown';
    dayCounts.set(dayLabel, (dayCounts.get(dayLabel) || 0) + 1);
    if (recent.length < 10) {
      recent.push({
        formNumber: d.formNumber || doc.id,
        guardianName: d.guardian?.name || '-',
        status: s,
      });
    }
  });

  const weekTag = weekEndIso.slice(0, 10);
  const results = await Promise.allSettled(WEEKLY_REPORT_RECIPIENTS.map((to) =>
    enqueueEmail(db, `weekly-report-${tid}-${weekTag}-${to.replace(/[^a-z0-9]/gi, '_')}`, {
      to,
      templateType: TEMPLATE_PICKUP_WEEKLY_REPORT,
      tenantId: tid,
      source: 'weekly_pickup_report',
      templateData: {
        weekStart: weekStartIso,
        weekEnd: weekEndIso,
        total: snap.size,
        byStatus,
        daily: Array.from(dayCounts.entries()).map(([label, count]) => ({ label, count })),
        recent,
      },
    })
  ));
  const queued = results.filter((r) => r.status === 'fulfilled').length;
  logger.info('Weekly pickup report queued', { total: snap.size, byStatus, queued, weekTag });
});

// ─── Security incident alert (instant email on new incident) ────────────────
exports.securityIncidentAlert = onDocumentCreated({
  document: 'tenants/{tenantId}/security_incidents/{incidentId}',
  region: 'asia-southeast2',
}, async (event) => {
  const snap = event.data;
  if (!snap) return;
  const db = admin.firestore();
  const { tenantId, incidentId } = event.params;
  const d = snap.data() || {};

  if (!shouldSendSecurityIncidentEmail(d)) {
    logger.info('Security incident email suppressed by policy', {
      tenantId,
      incidentId,
      kind: d.kind || d.type || null,
      source: d.source || null,
      service: d.service || null,
    });
    return;
  }

  const pick = (v) => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') return v.name || v.fullName || '';
    return String(v);
  };

  const templateData = {
    type: d.type || d.kind || 'security_incident',
    createdAt: typeof d.createdAt === 'string'
      ? d.createdAt
      : (d.createdAt?.toDate?.()?.toISOString?.() || new Date().toISOString()),
    gate: d.gate || d.terminalId || d.source || '',
    chaperoneName: d.chaperoneName || pick(d.chaperone) || pick(d.target),
    studentName: pick(d.student),
    notes: d.notes || d.summary || '',
    eventId: d.eventId || incidentId,
    confidence: typeof d.confidence === 'number' ? d.confidence : null,
    livenessScore: typeof d.livenessScore === 'number' ? d.livenessScore : null,
  };

  // Deterministic job IDs (create(), not set) so retried triggers can't double-send
  const results = await Promise.allSettled(SECURITY_ALERT_RECIPIENTS.map((to) =>
    enqueueEmail(db, `sec-alert-${tenantId}-${incidentId}-${to.replace(/[^a-z0-9]/gi, '_')}`, {
      to,
      templateType: TEMPLATE_PICKUP_SECURITY_INCIDENT,
      tenantId,
      recordId: incidentId,
      source: 'security_incident_alert',
      templateData,
    })
  ));
  const queued = results.filter((r) => r.status === 'fulfilled').length;
  logger.info('Security incident alert queued', { tenantId, incidentId, type: templateData.type, queued });
});
