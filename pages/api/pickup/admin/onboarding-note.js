/**
 * POST /api/pickup/admin/onboarding-note
 *
 * Append an internal admin note to a submitted onboarding form.
 * Notes are ACOP-internal — never emailed to the guardian.
 *
 * Body: { recordId: string, note: string }
 */
import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase } from '../../../../lib/firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');

async function handler(req, res) {
  try {
    const { recordId, note } = req.body || {};
    if (!recordId || typeof recordId !== 'string') {
      return res.status(400).json({ error: 'recordId required' });
    }
    const text = String(note || '').trim();
    if (!text) return res.status(400).json({ error: 'note required' });
    if (text.length > 2000) return res.status(400).json({ error: 'note too long (max 2000 chars)' });

    initializeFirebase();
    const db = admin.firestore();
    const tid = tenancy.getTenantId();
    const ref = db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'record not found' });

    const actor = {
      uid: req.user?.email || null,
      email: req.user?.email || null,
      name: req.user?.name || null,
      role: req.user?.role || null,
    };
    const entry = {
      text,
      by: { email: actor.email, name: actor.name },
      at: new Date().toISOString(),
    };

    await ref.set({
      adminNotes: admin.firestore.FieldValue.arrayUnion(entry),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    const rec = snap.data() || {};
    await logAudit(db, {
      tenantId: tid,
      actor,
      kind: 'onboarding.note_added',
      target: { type: 'pickup_onboarding', id: recordId, label: rec.formNumber || recordId },
      summary: `Added internal note to form ${rec.formNumber || recordId}`,
      metadata: { note: text.slice(0, 500) },
      req,
    });

    return res.status(200).json({ ok: true, recordId, note: entry });
  } catch (err) {
    console.error('[pickup/admin/onboarding-note]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, {
  methods: ['POST'],
  permission: 'pickup_admin.edit_chaperone',
  rateLimit: 60,
});
