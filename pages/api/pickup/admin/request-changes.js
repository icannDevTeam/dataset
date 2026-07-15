/**
 * POST /api/pickup/admin/request-changes
 *
 * Ask the guardian to correct something on a submitted onboarding form
 * (e.g. re-send a clearer chaperone photo) WITHOUT reopening the form.
 * The parent replies via email (reply-to = ACOP) or WhatsApp; ACOP then
 * applies the fix with the existing onboarding editor. Student locks are
 * untouched so no duplicate submissions/documents are possible.
 *
 * Sets status → 'changes_requested' and enqueues a
 * `pickup_onboarding_changes_requested` email to guardian.email.
 *
 * Body: { recordId: string, message: string }
 */
import admin from 'firebase-admin';
import { withApi } from '../../../../lib/api-auth';
import { initializeFirebase } from '../../../../lib/firebase-admin';

const tenancy = require('../../../../lib/tenancy');
const { logAudit } = require('../../../../lib/audit-log');

const TEMPLATE_CHANGES_REQUESTED = 'pickup_onboarding_changes_requested';

function queueJobId(tid, recordId) {
  // Unique per request so repeat follow-ups each send a fresh email.
  const safe = `${tid}-${recordId}-changes-${Date.now()}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return safe.slice(0, 180);
}

async function resolveAcopReplyTo(db, tid, fallbackEmail) {
  try {
    const snap = await db.doc(tenancy.pickupSettingsDoc(tid)).get();
    const configured = String(snap.data()?.acopEmail || '').trim();
    if (configured && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configured)) return configured;
  } catch { /* fall through */ }
  return fallbackEmail || null;
}

async function handler(req, res) {
  try {
    const { recordId, message } = req.body || {};
    if (!recordId || typeof recordId !== 'string') {
      return res.status(400).json({ error: 'recordId required' });
    }
    const trimmedMessage = String(message || '').trim();
    if (trimmedMessage.length < 4) {
      return res.status(400).json({ error: 'message required (min 4 chars)' });
    }
    if (trimmedMessage.length > 2000) {
      return res.status(400).json({ error: 'message too long (max 2000 chars)' });
    }

    initializeFirebase();
    const db = admin.firestore();
    const tid = tenancy.getTenantId();
    const ref = db.doc(`${tenancy.pickupOnboardingPath(tid)}/${recordId}`);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'record not found' });

    const rec = snap.data() || {};
    if (!['pending', 'changes_requested'].includes(rec.status)) {
      return res.status(409).json({ error: `record status is ${rec.status}` });
    }

    const guardianEmail = String(rec.guardian?.email || '').trim().toLowerCase();
    if (!guardianEmail) {
      return res.status(422).json({ error: 'no guardian email on this form' });
    }

    const actor = {
      uid: req.user?.email || null,
      email: req.user?.email || null,
      name: req.user?.name || null,
      role: req.user?.role || null,
    };
    const nowIso = new Date().toISOString();
    const replyTo = await resolveAcopReplyTo(db, tid, actor.email);

    await ref.set({
      status: 'changes_requested',
      changesRequestedAt: nowIso,
      changesRequestedBy: actor.email || 'admin',
      changesRequestedMessage: trimmedMessage,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Enqueue the guardian email (root email_queue collection, processed by
    // firebase-functions processEmailQueue → Resend).
    const jobId = queueJobId(tid, recordId);
    await db.doc(`email_queue/${jobId}`).set({
      status: 'pending',
      templateType: TEMPLATE_CHANGES_REQUESTED,
      tenantId: tid,
      recordId,
      formNumber: rec.formNumber || null,
      to: guardianEmail,
      replyTo: replyTo || null,
      templateData: {
        guardianName: rec.guardian?.name || null,
        formNumber: rec.formNumber || null,
        requestedAt: nowIso,
        requestedBy: actor.name || actor.email || 'ACOP Team',
        message: trimmedMessage,
        contactEmail: replyTo || 'inquiries.simprug@binus.edu',
        students: (rec.students || []).map((s) => ({
          name: s?.name || null,
          gradeSelection: s?.gradeSelection || null,
          homeroom: s?.homeroom || null,
        })),
      },
      retryCount: 0,
      maxRetries: 3,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'pickup_admin_request_changes',
    }, { merge: false });

    await logAudit(db, {
      tenantId: tid,
      actor,
      kind: 'onboarding.changes_requested',
      target: { type: 'pickup_onboarding', id: recordId, label: rec.formNumber || recordId },
      before: { status: rec.status },
      after: { status: 'changes_requested' },
      summary: `Requested changes on form ${rec.formNumber || recordId}`,
      metadata: { message: trimmedMessage.slice(0, 500), emailJobId: jobId, to: guardianEmail },
      req,
    });

    return res.status(200).json({ ok: true, recordId, status: 'changes_requested', emailJobId: jobId, to: guardianEmail });
  } catch (err) {
    console.error('[pickup/admin/request-changes]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, {
  methods: ['POST'],
  permission: 'pickup_admin.edit_chaperone',
  rateLimit: 30,
});
