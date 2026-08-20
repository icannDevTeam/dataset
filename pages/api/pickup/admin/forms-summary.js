/**
 * GET /api/pickup/admin/forms-summary
 *
 * Returns onboarding forms counts by status + the 5 most recent pending
 * submissions (lightweight — no Storage signing, no student photo enrichment).
 * Used by the dashboard and analytics pages for the forms overview widget.
 *
 * Response:
 *   { ok, counts: { pending, changes_requested, approved, rejected, archived, total },
 *     recentPending: [{ id, submittedAt, guardianName, studentNames[], status }] }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');

const SUMMARY_CACHE_TTL_MS = 10 * 1000;
const summaryCache = new Map();

async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' });
  const tid = req.query.tenant ? String(req.query.tenant) : tenancy.getTenantId();
  const cacheKey = `summary:${tid}`;

  const cached = summaryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.status(200).json(cached.payload);
  }

  try {
    initializeFirebase();
    const db = admin.firestore();
    const col = db.collection(tenancy.pickupOnboardingPath(tid));

    // Use aggregate count() for status counters to avoid large document reads.
    const [
      pendingSnap,
      pendingCountAgg,
      changesCountAgg,
      approvedCountAgg,
      rejectedCountAgg,
      archivedCountAgg,
    ] = await Promise.all([
      col.where('status', '==', 'pending').limit(10).get(),
      col.where('status', '==', 'pending').count().get(),
      col.where('status', '==', 'changes_requested').count().get(),
      col.where('status', '==', 'approved').count().get(),
      col.where('status', '==', 'rejected').count().get(),
      col.where('status', '==', 'archived').count().get(),
    ]);

    const pending = Number(pendingCountAgg.data().count || 0);
    const changes_requested = Number(changesCountAgg.data().count || 0);
    const approved = Number(approvedCountAgg.data().count || 0);
    const rejected = Number(rejectedCountAgg.data().count || 0);
    const archived = Number(archivedCountAgg.data().count || 0);

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

    const payload = {
      ok: true,
      counts: {
        pending,
        changes_requested,
        approved,
        rejected,
        archived,
        total: pending + changes_requested + approved + rejected + archived,
      },
      recentPending,
    };

    summaryCache.set(cacheKey, { payload, expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS });
    return res.status(200).json(payload);
  } catch (err) {
    console.error('[forms-summary]', err.message);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { methods: ['GET'], permission: 'pickup_admin.view' });
