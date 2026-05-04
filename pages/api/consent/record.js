/**
 * POST /api/consent/record
 *
 * Body: { token, guardianName, guardianRelation?, guardianEmail, signature }
 * `signature` is the typed-name confirmation displayed on the consent page.
 *
 * Records a consent doc under the tenant scoped path. The consent is
 * permanently linked to the policy version that is *currently* active —
 * if the policy version has changed since the token was minted, the
 * consent is recorded under the new version (which is the safer choice).
 */
import { initializeFirebase } from '../../../lib/firebase-admin';
import admin from 'firebase-admin';

const tenancy = require('../../../lib/tenancy');
const { verifyConsentToken } = require('../../../lib/consent-token');

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { token, guardianName, guardianRelation = 'guardian', guardianEmail, signature } = req.body || {};
  const claims = verifyConsentToken(token || '');
  if (!claims) return res.status(401).json({ error: 'invalid or expired token' });
  if (!guardianName || !guardianEmail || !signature) {
    return res.status(400).json({ error: 'guardianName, guardianEmail, signature required' });
  }
  if (signature.trim().toLowerCase() !== guardianName.trim().toLowerCase()) {
    return res.status(400).json({ error: 'typed signature must match guardian name' });
  }

  const { tid, sid } = claims;
  try {
    initializeFirebase();
    const db = admin.firestore();

    const cfgSnap = await db.doc(`${tenancy.tenantDoc(tid)}/settings/config`).get();
    const policyVersionId = cfgSnap.exists ? (cfgSnap.data() || {}).currentPolicyVersionId : null;
    if (!policyVersionId) return res.status(409).json({ error: 'tenant has no active policy' });

    const now = new Date().toISOString();
    const doc = {
      studentId: sid,
      tenantId: tid,
      guardianName: guardianName.trim(),
      guardianEmail: guardianEmail.trim().toLowerCase(),
      guardianRelation,
      policyVersionId,
      consentedAt: now,
      ipAddress: clientIp(req),
      userAgent: req.headers['user-agent'] || null,
      signatureMethod: 'click',
      signatureRef: signature.trim(),
      expiresAt: null,
      withdrawnAt: null,
      withdrawalReason: null,
    };
    await db.doc(`${tenancy.consentsPath(tid)}/${sid}`).set(doc, { merge: false });

    return res.status(200).json({ ok: true, policyVersionId, consentedAt: now });
  } catch (err) {
    console.error('[consent/record]', err.message);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}
