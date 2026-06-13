/**
 * GET /api/pickup/admin/forms-summary
 *
 * Returns onboarding forms counts by status + the 5 most recent pending
 * submissions (lightweight — no Storage signing, no student photo enrichment).
 * Used by the dashboard and analytics pages for the forms overview widget.
 *
 * Response:
 *   { ok, counts: { pending, approved, rejected, total },
 *     recentPending: [{ id, submittedAt, guardianName, studentNames[], status }] }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();

  try {
    initializeFirebase();
    const db = admin.firestore();
    const col = db.collection(tenancy.pickupOnboardingPath(tid));

    // Fetch pending (with docs), approved + rejected counts only
    const [pendingSnap, approvedSnap, rejectedSnap] = await Promise.all([
      col.where('status', '==', 'pending').limit(20).get(),
      col.where('status', '==', 'approved').limit(500).get(),
      col.where('status', '==', 'rejected').limit(500).get(),
    ]);

    const pending  = pendingSnap.size;
    const approved = approvedSnap.size;
    const rejected = rejectedSnap.size;

    function toIso(ts) {
      if (!ts) return null;
      try { return ts.toDate ? ts.toDate().toISOString() : new Date(ts).toISOString(); }
      catch { return null; }
    }

    const sortedPendingDocs = [...pendingSnap.docs].sort((a, b) => {
      const ta = a.data().submittedAt?.toMillis?.() ?? 0;
      const tb = b.data().submittedAt?.toMillis?.() ?? 0;
      return tb - ta;
    });

    const recentPending = sortedPendingDocs.slice(0, 5).map((d) => {
      const data = d.data();
      return {
        id: d.id,
        status: data.status || 'pending',
        submittedAt: toIso(data.submittedAt),
        guardianName: data.guardian?.name || '—',
        studentNames: (data.students || []).map((s) => s.name || '—'),
      };
    });

    return res.status(200).json({
      ok: true,
      counts: { pending, approved, rejected, total: pending + approved + rejected },
      recentPending,
    });
  } catch (err) {
    console.error('[forms-summary]', err.message);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { methods: ['GET'], permission: 'pickup_admin.view' });
