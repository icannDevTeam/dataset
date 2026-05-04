/**
 * GET /api/consent/status?token=<consent-token>
 *
 * Public endpoint — given a guardian's consent token, returns:
 *   { student: {id, name, homeroom}, status, policyVersionId, currentPolicyVersionId }
 */
import { initializeFirebase } from '../../../lib/firebase-admin';
import admin from 'firebase-admin';

const tenancy = require('../../../lib/tenancy');
const { verifyConsentToken } = require('../../../lib/consent-token');

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const token = (req.query.token || '').toString();
  const claims = verifyConsentToken(token);
  if (!claims) return res.status(401).json({ error: 'invalid or expired token' });
  const { tid, sid } = claims;
  try {
    initializeFirebase();
    const db = admin.firestore();

    const [studentSnap, metaSnap, consentSnap, cfgSnap] = await Promise.all([
      db.doc(`${tenancy.studentsPath(tid)}/${sid}`).get(),
      db.doc(`${tenancy.studentMetadataPath(tid)}/${sid}`).get(),
      db.doc(`${tenancy.consentsPath(tid)}/${sid}`).get(),
      db.doc(`${tenancy.tenantDoc(tid)}/settings/config`).get(),
    ]);

    const student = studentSnap.exists ? studentSnap.data() : (metaSnap.exists ? metaSnap.data() : null);
    const consent = consentSnap.exists ? consentSnap.data() : null;
    const currentPolicyVersionId = cfgSnap.exists ? (cfgSnap.data() || {}).currentPolicyVersionId : null;

    let state = 'missing';
    if (consent) {
      if (consent.withdrawnAt) state = 'withdrawn';
      else if (consent.expiresAt && consent.expiresAt < new Date().toISOString()) state = 'expired';
      else if (currentPolicyVersionId && consent.policyVersionId !== currentPolicyVersionId) state = 'stale';
      else state = 'active';
    }

    return res.status(200).json({
      tenantId: tid,
      student: student
        ? { id: sid, name: student.name || student.studentName || null, homeroom: student.homeroom || null }
        : { id: sid, name: null, homeroom: null },
      state,
      currentPolicyVersionId,
      consentedPolicyVersionId: consent?.policyVersionId || null,
      consentedAt: consent?.consentedAt || null,
      withdrawnAt: consent?.withdrawnAt || null,
    });
  } catch (err) {
    console.error('[consent/status]', err.message);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}
