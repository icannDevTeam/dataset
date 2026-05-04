/**
 * GET  /api/pickup/admin/settings  — read pickup settings doc
 * POST /api/pickup/admin/settings  — update pickup settings (merge)
 *
 * Supported fields (body):
 *   allowSelfClaim  boolean  — TV can self-claim via kiosk code without admin
 *
 * Protected: requires session auth (same as all pickup admin APIs).
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'method' });
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const tid = tenancy.getTenantId();
    const docRef = db.doc(tenancy.pickupSettingsDoc(tid));

    if (req.method === 'GET') {
      const snap = await docRef.get();
      const data = snap.exists ? snap.data() : {};
      return res.status(200).json({
        ok: true,
        settings: {
          allowSelfClaim: data.allowSelfClaim === true,
        },
      });
    }

    // POST — validate and merge
    const body = req.body || {};
    const patch = {};

    if ('allowSelfClaim' in body) {
      if (typeof body.allowSelfClaim !== 'boolean') {
        return res.status(400).json({ error: 'allowSelfClaim must be a boolean' });
      }
      patch.allowSelfClaim = body.allowSelfClaim;
    }

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'no valid fields in body' });
    }

    await docRef.set(patch, { merge: true });
    return res.status(200).json({ ok: true, updated: patch });
  } catch (e) {
    console.error('[pickup/admin/settings]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}
