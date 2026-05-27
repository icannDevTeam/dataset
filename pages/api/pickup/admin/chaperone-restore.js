/**
 * POST /api/pickup/admin/chaperone-restore
 *
 * Reverse a shadow-delete: set lifecycleStatus back to 'active', clear the
 * delete fields, and append a `restore` revision snapshot.
 *
 * Body: { chaperoneId: string, reason?: string }
 */
import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase } from '../../../../lib/firebase-admin';
const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');

async function handler(req, res) {
  try {
    const { chaperoneId, reason } = req.body || {};
    if (!chaperoneId || typeof chaperoneId !== 'string') {
      return res.status(400).json({ error: 'chaperoneId required' });
    }
    const trimmedReason = String(reason || '').trim().slice(0, 500) || null;

    initializeFirebase();
    const db = admin.firestore();
    const tid = tenancy.getTenantId();
    const ref = db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'chaperone not found' });

    const before = snap.data() || {};
    if (before.lifecycleStatus !== 'deleted') {
      return res.status(409).json({ error: 'not_deleted' });
    }

    const actor = {
      uid: req.user?.email || null,
      email: req.user?.email || null,
      name: req.user?.name || null,
      role: req.user?.role || null,
    };
    const now = admin.firestore.FieldValue.serverTimestamp();
    const nowIso = new Date().toISOString();

    const update = {
      lifecycleStatus: 'active',
      restoredAt: now,
      restoredBy: { uid: actor.uid, email: actor.email },
      // Keep deletedAt/deletedBy/deletedReason for audit traceability —
      // the revision history is the source of truth for repeat cycles.
    };
    await ref.set(update, { merge: true });

    const revisionRef = await ref.collection('revisions').add({
      at: nowIso,
      atServerTs: now,
      by: { uid: actor.uid, email: actor.email, name: actor.name, role: actor.role },
      action: 'restore',
      reason: trimmedReason,
      snapshot: before,
    });

    await logAudit(db, {
      tenantId: tid,
      actor,
      kind: 'chaperone.shadow_restore',
      target: { type: 'chaperone', id: chaperoneId, label: before.name || chaperoneId },
      before: { lifecycleStatus: 'deleted' },
      after: { lifecycleStatus: 'active' },
      summary: `Restored chaperone ${before.name || chaperoneId}`,
      metadata: { revisionId: revisionRef.id, reason: trimmedReason },
      req,
    });

    return res.status(200).json({
      ok: true,
      chaperoneId,
      lifecycleStatus: 'active',
      revisionId: revisionRef.id,
    });
  } catch (err) {
    console.error('[pickup/admin/chaperone-restore]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, {
  methods: ['POST'],
  permission: 'pickup_admin.delete_chaperone',
  rateLimit: 20,
});
