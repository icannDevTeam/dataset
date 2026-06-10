/**
 * POST /api/pickup/admin/reject
 *
 * Admin-only. Marks onboarding record rejected (no chaperone created,
 * staged photos remain for audit and are GC'd by retention job).
 *
 * Body: { recordId, tenant?, reason }
 */
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const TEMPLATE_PICKUP_ONBOARDING_REJECTED = 'pickup_onboarding_rejected';

function queueJobId(tid, recordId, templateType) {
  const safe = `${tid}-${recordId}-${templateType}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe.slice(0, 180);
}

async function enqueueRejectionNotification(db, tid, recordId, rec, reviewer, rejectedAt, reason) {
  const to = String(rec?.guardian?.email || '').trim().toLowerCase();
  if (!to) return;

  const jobId = queueJobId(tid, recordId, TEMPLATE_PICKUP_ONBOARDING_REJECTED);
  const queueRef = db.doc(`email_queue/${jobId}`);
  const existing = await queueRef.get();
  if (existing.exists) return;

  await queueRef.set({
    status: 'pending',
    templateType: TEMPLATE_PICKUP_ONBOARDING_REJECTED,
    tenantId: tid,
    recordId,
    formNumber: rec?.formNumber || null,
    to,
    templateData: {
      guardianName: rec?.guardian?.name || null,
      guardianEmail: rec?.guardian?.email || null,
      formNumber: rec?.formNumber || null,
      rejectedAt,
      rejectedBy: reviewer,
      rejectionReason: reason,
      students: (rec?.students || []).map((s) => ({
        name: s?.name || null,
        gradeSelection: s?.gradeSelection || null,
        homeroom: s?.homeroom || null,
      })),
    },
    retryCount: 0,
    maxRetries: 3,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    source: 'pickup_admin_reject',
  }, { merge: false });
}

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
    const reviewer = req.headers['x-admin-user'] || 'api-key';
    const rejectedAt = new Date().toISOString();
    const trimmedReason = reason.trim();

    await ref.set({
      status: 'rejected',
      reviewedAt: rejectedAt,
      reviewedBy: reviewer,
      rejectionReason: trimmedReason,
    }, { merge: true });
    // Phase 3: release per-student locks so the family can re-submit.
    try {
      const rec = snap.data();
      await Promise.all((rec.students || []).map((s) => {
        if (!s || !s.id) return null;
        return db.doc(`${tenancy.pickupStudentLocksPath(tid)}/${s.id}`).set({
          status: 'rejected',
          rejectedAt,
          rejectionReason: trimmedReason,
        }, { merge: true });
      }));
    } catch (e) { console.error('[reject] lock update', e.message); }

    try {
      await enqueueRejectionNotification(db, tid, recordId, snap.data(), reviewer, rejectedAt, trimmedReason);
    } catch (e) {
      console.error('[reject] rejection notification enqueue failed', e.message);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[pickup/admin/reject]', err.message);
    return res.status(500).json({ error: 'internal' });
  }
}

export default withApi(handler, { methods: ['POST'], permission: 'pickup_admin.reject' });
