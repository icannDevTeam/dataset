/**
 * lib/email.js — Outbound transactional email via Resend.
 *
 * One thin wrapper so callers don't have to import `resend` directly and
 * so we can swap providers later by editing this file alone. Returns a
 * uniform `{ ok, id?, error? }` shape.
 *
 * Required env:
 *   RESEND_API_KEY        — from https://resend.com/api-keys
 *
 * Optional env:
 *   INVITE_FROM_EMAIL     — defaults to Resend's shared sandbox sender.
 *                           Replace with a verified-domain address before
 *                           production use.
 *   INVITE_FROM_NAME      — friendly display name shown in mail clients.
 *   INVITE_REPLY_TO       — single address users can reply to.
 */
const { Resend } = require('resend');

const FROM_EMAIL = process.env.INVITE_FROM_EMAIL || 'onboarding@resend.dev';
const FROM_NAME = process.env.INVITE_FROM_NAME || 'BINUS Simprug Pickup';
const REPLY_TO = process.env.INVITE_REPLY_TO || 'albertarthursub@gmail.com';

let _client = null;
function getClient() {
  if (_client) return _client;
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    const err = new Error('RESEND_API_KEY not configured');
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }
  _client = new Resend(key);
  return _client;
}

/**
 * Send a transactional email.
 *
 * @param {object} opts
 * @param {string|string[]} opts.to
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {string} opts.text
 * @returns {Promise<{ok:boolean,id?:string,error?:string}>}
 */
async function sendEmail({ to, subject, html, text }) {
  if (!to || !subject || !(html || text)) {
    return { ok: false, error: 'missing_required_fields' };
  }
  let client;
  try {
    client = getClient();
  } catch (e) {
    console.error('[email] not configured:', e.message);
    return { ok: false, error: 'email_not_configured' };
  }

  try {
    const result = await client.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: Array.isArray(to) ? to : [to],
      reply_to: REPLY_TO,
      subject,
      html,
      text,
    });
    if (result?.error) {
      console.error('[email] resend error:', result.error);
      return { ok: false, error: result.error.message || 'send_failed' };
    }
    return { ok: true, id: result?.data?.id };
  } catch (err) {
    console.error('[email] exception:', err?.message);
    return { ok: false, error: err?.message || 'send_failed' };
  }
}

module.exports = {
  sendEmail,
  FROM_EMAIL,
  FROM_NAME,
  REPLY_TO,
};
