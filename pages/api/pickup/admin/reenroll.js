/**
 * POST /api/pickup/admin/reenroll
 *
 * Manually retry Hikvision enrollment for chaperones whose initial
 * push during approval failed (no devices reachable, bad image,
 * timeout, etc.). Idempotent — createUser tolerates "already exists".
 *
 * Body: { chaperoneIds?: string[], recordId?: string, tenant?: string }
 *   - If chaperoneIds is provided, those are enrolled directly.
 *   - Else if recordId is provided, every chaperone allocated for that
 *     pickup_onboarding record is re-enrolled.
 *
 * Response: { ok, summary: [{chaperoneId, ok, devices, error?}] }
 */
import { withAuth } from '../../../../lib/auth-middleware';
import { initializeFirebase, getFirebaseStorage } from '../../../../lib/firebase-admin';
import admin from 'firebase-admin';
import { enrollChaperones } from '../../../../lib/chaperone-enroll';

const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { chaperoneIds, recordId, tenant, gradeFilter, deviceIps } = req.body || {};
  const tid = tenant ? String(tenant) : tenancy.getTenantId();

  try {
    initializeFirebase();
    const db = admin.firestore();
    const bucket = getFirebaseStorage().bucket();

    let ids = Array.isArray(chaperoneIds) ? chaperoneIds.filter(Boolean) : [];

    if (ids.length === 0 && recordId) {
      const recSnap = await db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`).get();
      if (!recSnap.exists) return res.status(404).json({ error: 'record not found' });
      const rec = recSnap.data();
      ids = (rec.allocatedChaperones || []).map((c) => c.chaperoneId).filter(Boolean);
    }

    if (ids.length === 0) {
      return res.status(400).json({ error: 'no chaperoneIds resolved' });
    }

    const opts = {};
    if (Array.isArray(gradeFilter) && gradeFilter.length > 0) {
      opts.gradeFilter = gradeFilter.map(String);
    }
    if (Array.isArray(deviceIps) && deviceIps.length > 0) {
      opts.deviceIps = deviceIps.map(String);
    }

    const summary = await enrollChaperones(db, bucket, tid, ids, opts);

    if (recordId) {
      await db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`).set(
        { enrollment: summary, lastReenrollAt: new Date().toISOString() },
        { merge: true },
      );
    }

    await logAudit(db, {
      tenantId: tid, req,
      actor: { email: req.headers['x-admin-user'] || null, name: null, role: 'admin' },
      kind: 'chaperone.reenroll',
      target: { type: recordId ? 'onboarding' : 'chaperone', id: recordId || ids.join(','), label: recordId ? `onboarding:${recordId}` : `${ids.length} chaperone(s)` },
      after: { chaperoneIds: ids, summary, gradeFilter: opts.gradeFilter || null, deviceIps: opts.deviceIps || null },
      summary: `Re-enrolled ${ids.length} chaperone(s) on Hikvision terminals`,
    });
    return res.status(200).json({ ok: true, summary });
  } catch (err) {
    console.error('[pickup/admin/reenroll]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withAuth(handler);
