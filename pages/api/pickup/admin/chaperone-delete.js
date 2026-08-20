/**
 * POST /api/pickup/admin/chaperone-delete
 *
 * Shadow-delete a chaperone: flip lifecycleStatus → 'deleted' and record an
 * immutable revision snapshot under tenants/{tid}/chaperones/{cid}/revisions.
 * Also removes the chaperone's face + user record from all configured
 * Hikvision gate terminals (best-effort) so a deleted chaperone can no
 * longer open gates. Firestore data / facePaths are untouched — restore is
 * reversible, but requires a re-enroll to push faces back to devices.
 *
 * Body: { chaperoneId: string, reason: string }
 */
import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { unenrollChaperone } from '../../../../lib/chaperone-enroll';
const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');

async function handler(req, res) {
  try {
    const { chaperoneId, reason } = req.body || {};
    if (!chaperoneId || typeof chaperoneId !== 'string') {
      return res.status(400).json({ error: 'chaperoneId required' });
    }
    const trimmedReason = String(reason || '').trim();
    if (!trimmedReason) {
      return res.status(400).json({ error: 'reason required' });
    }
    if (trimmedReason.length > 500) {
      return res.status(400).json({ error: 'reason too long (max 500 chars)' });
    }

    initializeFirebase();
    const db = admin.firestore();
    const tid = tenancy.getTenantId();
    const ref = db.doc(`${tenancy.chaperonesPath(tid)}/${chaperoneId}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'chaperone not found' });

    const before = snap.data() || {};
    if (before.lifecycleStatus === 'deleted') {
      return res.status(409).json({ error: 'already_deleted' });
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
      lifecycleStatus: 'deleted',
      deletedAt: now,
      deletedBy: { uid: actor.uid, email: actor.email },
      deletedReason: trimmedReason,
      assignmentMode: 'derived',
      allowedTerminalIds: [],
      assignmentUpdatedAt: nowIso,
      assignmentUpdatedBy: actor.email,
      restoredAt: null,
      restoredBy: null,
    };
    await ref.set(update, { merge: true });

    // Revision snapshot (server-only via Admin SDK).
    const revisionRef = await ref.collection('revisions').add({
      at: nowIso,
      atServerTs: now,
      by: { uid: actor.uid, email: actor.email, name: actor.name, role: actor.role },
      action: 'delete',
      reason: trimmedReason,
      snapshot: before,
    });

    // Remove from gate terminals so the face can no longer open doors.
    // Best-effort: offline devices are reported, not fatal.
    let deviceRemoval = { ok: false, devices: [] };
    try {
      deviceRemoval = await unenrollChaperone(db, tid, chaperoneId);
    } catch (e) {
      deviceRemoval = { ok: false, devices: [], error: e.message };
    }

    await logAudit(db, {
      tenantId: tid,
      actor,
      kind: 'chaperone.shadow_delete',
      target: { type: 'chaperone', id: chaperoneId, label: before.name || chaperoneId },
      before: { lifecycleStatus: before.lifecycleStatus || 'active' },
      after: { lifecycleStatus: 'deleted', deletedReason: trimmedReason },
      summary: `Shadow-deleted chaperone ${before.name || chaperoneId}`,
      metadata: {
        revisionId: revisionRef.id,
        reason: trimmedReason,
        assignmentCleared: {
          hadOverride: before.assignmentMode === 'override',
          previousAllowedTerminalCount: Array.isArray(before.allowedTerminalIds) ? before.allowedTerminalIds.length : 0,
        },
        deviceRemoval: {
          ok: deviceRemoval.ok,
          devices: (deviceRemoval.devices || []).map((d) => ({ ip: d.ip, ok: d.ok, error: d.error || null })),
          error: deviceRemoval.error || null,
        },
      },
      req,
    });

    return res.status(200).json({
      ok: true,
      chaperoneId,
      lifecycleStatus: 'deleted',
      revisionId: revisionRef.id,
      deviceRemoval,
    });
  } catch (err) {
    console.error('[pickup/admin/chaperone-delete]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, {
  methods: ['POST'],
  permission: 'pickup_admin.delete_chaperone',
  rateLimit: 20,
});
