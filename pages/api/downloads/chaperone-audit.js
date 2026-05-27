/**
 * POST /api/downloads/chaperone-audit
 *
 * Exports the `tenants/{tid}/chaperones/{cid}/revisions` subcollection
 * across every chaperone in a date range. Each row is one shadow-delete /
 * restore / mutation snapshot.
 *
 * Follows the same shape + reauth contract as audit-log.js.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { runDownload } = require('../../../lib/download-runner');
const { MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = ctx.tenantId || tenancy.getTenantId();
  const fromMs = new Date(ctx.from + 'T00:00:00+07:00').getTime();
  const toMs   = new Date(ctx.to   + 'T23:59:59+07:00').getTime();

  // Two-step walk: chaperones first, then each `revisions` subcollection.
  // Firestore has no cross-collection-group query we can guarantee an
  // index for without adding one, and the volume is bounded.
  const chapSnap = await db.collection(tenancy.chaperonesPath(tid))
    .limit(MAX_ROWS + 1).get().catch(() => null);

  const rows = [];
  let truncated = false;
  if (chapSnap) {
    for (const cDoc of chapSnap.docs) {
      if (rows.length >= MAX_ROWS) { truncated = true; break; }
      const chap = cDoc.data() || {};
      const chapName = chap.name || cDoc.id;
      const revSnap = await db.collection(`${tenancy.chaperonesPath(tid)}/${cDoc.id}/revisions`)
        .orderBy('at', 'desc').limit(500).get().catch(() => null);
      if (!revSnap) continue;
      revSnap.forEach((rDoc) => {
        if (rows.length >= MAX_ROWS) { truncated = true; return; }
        const r = rDoc.data() || {};
        const ts = r.at ? Date.parse(r.at) : NaN;
        if (Number.isNaN(ts) || ts < fromMs || ts > toMs) return;
        const action = r.action || '\u2014';
        const byEmail = r.by?.email || r.by?.uid || '\u2014';
        rows.push({
          when:        (r.at || '').slice(0, 19).replace('T', ' '),
          action,
          chaperoneId: cDoc.id,
          name:        chapName,
          employeeNo:  chap.employeeNo || '',
          by:          byEmail,
          role:        r.by?.role || '',
          reason:      (r.reason || '').slice(0, 200),
        });
      });
    }
  }
  return { rows, meta: { truncated } };
}

function kpis(rows, ctx) {
  const actionCount = { create: 0, update: 0, delete: 0, restore: 0 };
  const actorSet = new Set(); const chaperoneSet = new Set();
  for (const r of rows) {
    if (actionCount[r.action] != null) actionCount[r.action]++;
    actorSet.add(r.by); chaperoneSet.add(r.chaperoneId);
  }
  return [
    ['Total revisions',     rows.length.toLocaleString()],
    ['Chaperones affected', chaperoneSet.size.toLocaleString()],
    ['Unique actors',       actorSet.size.toLocaleString()],
    ['Deletes',             actionCount.delete.toLocaleString()],
    ['Restores',            actionCount.restore.toLocaleString()],
    ['Days covered',        ctx.days],
  ];
}

export default withApi(runDownload({
  cardId: 'chaperone-audit',
  title: 'Chaperone Audit Trail',
  subtitle: 'Shadow-delete / restore / mutation revisions per chaperone',
  theme: 'orange',
  sheetName: 'Chaperone Audit',
  maxDays: 365,
  columns: [
    { id: 'when',        label: 'When',         width: 13 },
    { id: 'action',      label: 'Action',       width: 9 },
    { id: 'chaperoneId', label: 'Chaperone ID', width: 12 },
    { id: 'name',        label: 'Name',         width: 18 },
    { id: 'employeeNo',  label: 'EmployeeNo',   width: 9 },
    { id: 'by',          label: 'By',           width: 17 },
    { id: 'role',        label: 'Role',         width: 7 },
    { id: 'reason',      label: 'Reason',       width: 15 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_compliance', rateLimit: 30 });
