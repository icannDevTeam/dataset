/**
 * /api/pickup/admin/audit-log — Recent audit entries.
 *
 * GET ?limit=200&kind=...&from=YYYY-MM-DD&to=YYYY-MM-DD&actor=...
 *
 * Returns audit-trail entries written by `lib/audit-log.js#logAudit`.
 * Bound by tenant. Read-only.
 */
import { initializeFirebase, getFirestoreDB } from '../../../../lib/firebase-admin';
import { withApi } from '../../../../lib/api-auth';
const tenancy = require('../../../../lib/tenancy');
const { auditLogPath } = require('../../../../lib/audit-log');

async function handler(req, res) {
  initializeFirebase();
  const db = getFirestoreDB();
  if (!db) return res.status(500).json({ error: 'firestore_unavailable' });

  const tid = tenancy.getTenantId();
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '100', 10)));
  const kind   = (req.query.kind   || '').trim();
  const from   = (req.query.from   || '').trim();   // YYYY-MM-DD
  const to     = (req.query.to     || '').trim();
  const actor  = (req.query.actor  || '').trim().toLowerCase();
  const search = (req.query.q      || '').trim().toLowerCase();

  try {
    let q = db.collection(auditLogPath(tid)).orderBy('at', 'desc').limit(limit);
    const snap = await q.get();

    const fromTs = from ? Date.parse(from + 'T00:00:00Z') : null;
    const toTs   = to   ? Date.parse(to   + 'T23:59:59Z') : null;

    const entries = [];
    let kinds = new Set();
    let actors = new Set();

    snap.forEach((doc) => {
      const e = doc.data() || {};
      const at = e.at || null;
      const tsMs = at ? Date.parse(at) : NaN;
      kinds.add(e.kind);
      if (e.actor?.email) actors.add(e.actor.email);

      if (kind && e.kind !== kind) return;
      if (fromTs && (!Number.isNaN(tsMs) ? tsMs < fromTs : true)) return;
      if (toTs   && (!Number.isNaN(tsMs) ? tsMs > toTs   : true)) return;
      if (actor) {
        const a = (e.actor?.email || e.actor?.name || '').toLowerCase();
        if (!a.includes(actor)) return;
      }
      if (search) {
        const blob = JSON.stringify(e).toLowerCase();
        if (!blob.includes(search)) return;
      }
      entries.push({ id: doc.id, ...e });
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      entries,
      total: entries.length,
      facets: {
        kinds: [...kinds].sort(),
        actors: [...actors].sort(),
      },
    });
  } catch (err) {
    console.error('[audit-log GET]', err.message, err.stack);
    return res.status(500).json({ error: 'internal', message: err.message });
  }
}

export default withApi(handler, { methods: ['GET'], permission: 'pickup_admin.view' });
