/**
 * GET  /api/pickup/admin/settings  — read pickup settings doc
 * POST /api/pickup/admin/settings  — update pickup settings (merge)
 *
 * Supported fields (body):
 *   allowSelfClaim  boolean  — TV can self-claim via kiosk code without admin
 *
 * RBAC: GET requires `pickup_admin.settings_view`,
 *       POST requires `pickup_admin.settings_edit`.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');
const { withApi } = require('../../../../lib/api-auth');
const { can } = require('../../../../lib/rbac');

async function handler(req, res) {
  // Per-method permission split is enforced inside the handler so a single
  // wrapper can serve both verbs.
  if (req.method === 'POST' && !req.user.superAdmin && !can(req.user.permissions, 'pickup_admin.settings_edit')) {
    return res.status(403).json({ error: 'forbidden', need: ['pickup_admin.settings_edit'] });
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

    const beforeSnap = await docRef.get();
    const before = beforeSnap.exists ? beforeSnap.data() : {};

    await docRef.set(patch, { merge: true });
    await logAudit(db, {
      tenantId: tid,
      actor: { email: req.user.email, name: req.user.name, role: req.user.role },
      req,
      kind: 'settings.update',
      target: { type: 'pickup_settings', id: 'pickup', label: 'Pickup Settings' },
      before: Object.fromEntries(Object.keys(patch).map(k => [k, before[k] ?? null])),
      after: patch,
      summary: `Updated pickup settings: ${Object.keys(patch).join(', ')}`,
    });
    return res.status(200).json({ ok: true, updated: patch });
  } catch (e) {
    console.error('[pickup/admin/settings]', e.message);
    return res.status(500).json({ error: 'internal', message: e.message });
  }
}

export default withApi(handler, {
  methods: ['GET', 'POST'],
  // GET only needs the view grant; POST also needs settings_edit (checked above).
  permission: 'pickup_admin.settings_view',
});
