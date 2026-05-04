/**
 * GET /api/consent/policy?tenant=<slug>
 *
 * Public endpoint — returns the currently active Privacy Policy for a tenant.
 * No auth: needed by the unauthenticated guardian consent page.
 */
import { initializeFirebase } from '../../../lib/firebase-admin';
import admin from 'firebase-admin';

const tenancy = require('../../../lib/tenancy');

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const tenantId = (req.query.tenant || tenancy.getTenantId()).toString();
  try {
    initializeFirebase();
    const db = admin.firestore();
    const cfgSnap = await db.doc(`${tenancy.tenantDoc(tenantId)}/settings/config`).get();
    if (!cfgSnap.exists) return res.status(404).json({ error: 'tenant not found' });
    const cfg = cfgSnap.data() || {};
    const versionId = cfg.currentPolicyVersionId;
    if (!versionId) return res.status(404).json({ error: 'no active policy' });
    const polSnap = await db.doc(`${tenancy.policyVersionsPath(tenantId)}/${versionId}`).get();
    if (!polSnap.exists) return res.status(404).json({ error: 'policy version missing' });
    const pol = polSnap.data() || {};
    return res.status(200).json({
      tenantId,
      versionId,
      effectiveDate: pol.effectiveDate,
      sha256: pol.sha256,
      bodyFormat: pol.bodyFormat || 'markdown',
      body: pol.body,
      tenantName: cfg.name || cfg.slug || tenantId,
      branding: cfg.branding || null,
    });
  } catch (err) {
    console.error('[consent/policy]', err.message);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}
