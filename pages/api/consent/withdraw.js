/**
 * POST /api/consent/withdraw
 * Body: { token, reason? }
 *
 * Marks the consent for the token's student as withdrawn. Per Privacy
 * Policy §6 this triggers a downstream deletion job within 30 days
 * (tracked separately by the data-requests worker — Phase B5).
 */
import { initializeFirebase } from '../../../lib/firebase-admin';
import admin from 'firebase-admin';

const tenancy = require('../../../lib/tenancy');
const { verifyConsentToken } = require('../../../lib/consent-token');

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { token, reason = 'guardian_request' } = req.body || {};
  const claims = verifyConsentToken(token || '');
  if (!claims) return res.status(401).json({ error: 'invalid or expired token' });
  const { tid, sid } = claims;

  try {
    initializeFirebase();
    const db = admin.firestore();
    const ref = db.doc(`${tenancy.consentsPath(tid)}/${sid}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'no consent on file' });
    const now = new Date().toISOString();
    await ref.update({ withdrawnAt: now, withdrawalReason: String(reason).slice(0, 500) });
    return res.status(200).json({ ok: true, withdrawnAt: now });
  } catch (err) {
    console.error('[consent/withdraw]', err.message);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}
