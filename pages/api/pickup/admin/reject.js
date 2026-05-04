/**
 * POST /api/pickup/admin/reject
 *
 * Admin-only. Marks onboarding record rejected (no chaperone created,
 * staged photos remain for audit and are GC'd by retention job).
 *
 * Body: { recordId, tenant?, reason }
 */
import { withAuth } from '../../../../lib/auth-middleware';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';

const tenancy = require('../../../../lib/tenancy');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { recordId, tenant, reason } = req.body || {};
  if (!recordId || typeof recordId !== 'string') return res.status(400).json({ error: 'recordId required' });
  if (!reason || typeof reason !== 'string' || reason.trim().length < 4) {
    return res.status(400).json({ error: 'reason required (min 4 chars)' });
  }
  const tid = tenant ? String(tenant) : tenancy.getTenantId();
  try {
    initializeFirebase();
    const db = admin.firestore();
    const ref = db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'record not found' });
    if (snap.data().status !== 'pending') {
      return res.status(409).json({ error: `record status is ${snap.data().status}` });
    }
    await ref.set({
      status: 'rejected',
      reviewedAt: new Date().toISOString(),
      reviewedBy: req.headers['x-admin-user'] || 'api-key',
      rejectionReason: reason.trim(),
    }, { merge: true });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[pickup/admin/reject]', err.message);
    return res.status(500).json({ error: 'internal' });
  }
}

export default withAuth(handler);
