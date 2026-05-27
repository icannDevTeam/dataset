/**
 * POST /api/downloads/chaperone-roster
 * Full chaperone directory from `tenants/{tid}/chaperones`.
 *
 * No date range — always a full snapshot. Permission moved from
 * `download_operational` to `download_compliance` (chaperone records
 * include sensitive identity data and live in the compliance bucket
 * alongside the audit trail).
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

  const snap = await db.collection(tenancy.chaperonesPath(tid))
    .orderBy('createdAt', 'desc').limit(MAX_ROWS + 1).get().catch(() => null);

  const rows = [];
  let truncated = false;
  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const c = d.data() || {};
      const status = c.status || (c.suspended ? 'suspended' : 'active');
      const faceCount = (c.facePaths || c.photoUrls || []).length;
      const lifecycle = c.lifecycleStatus || 'active';
      const deletedAtIso = c.deletedAt?.toDate ? c.deletedAt.toDate().toISOString()
        : (typeof c.deletedAt === 'string' ? c.deletedAt : '');
      const createdIso = c.createdAt?.toDate ? c.createdAt.toDate().toISOString()
        : (typeof c.createdAt === 'string' ? c.createdAt : '');
      rows.push({
        name:       c.name || '\u2014',
        relation:   c.relation || c.relationship || '',
        phone:      c.phone || '',
        email:      c.email || '',
        idNumber:   c.idNumber || '',
        authorized: (c.authorizedStudentIds || []).join(', '),
        faces:      faceCount,
        status,
        lifecycle,
        deletedAt:  deletedAtIso ? deletedAtIso.slice(0, 19).replace('T', ' ') : '',
        deletedReason: c.deletedReason || '',
        enrolled:   c.deviceEnrolled ? 'YES' : '',
        added:      createdIso ? createdIso.slice(0, 10) : '',
      });
    });
  }
  return { rows, meta: { truncated } };
}

function kpis(rows) {
  let active = 0, suspended = 0, withFaces = 0, deletedCount = 0;
  for (const r of rows) {
    if (r.status === 'suspended') suspended++; else active++;
    if (r.faces > 0) withFaces++;
    if (r.lifecycle === 'deleted') deletedCount++;
  }
  return [
    ['Total chaperones', rows.length.toLocaleString()],
    ['Active',           active.toLocaleString()],
    ['Suspended',        suspended.toLocaleString()],
    ['Shadow-deleted',   deletedCount.toLocaleString()],
    ['Face-enrolled',    withFaces.toLocaleString()],
    ['Enrollment rate',  rows.length ? `${((withFaces / rows.length) * 100).toFixed(1)}%` : '\u2014'],
    ['As of',            new Date().toISOString().slice(0, 10)],
  ];
}

export default withApi(runDownload({
  cardId: 'chaperone-roster',
  title: 'Chaperone Roster',
  subtitle: 'All registered pickup chaperones / guardians',
  theme: 'green',
  sheetName: 'Chaperones',
  needsRange: false,
  columns: [
    { id: 'name',          label: 'Name',                width: 14 },
    { id: 'relation',      label: 'Relation',            width: 7 },
    { id: 'phone',         label: 'Phone',               width: 11 },
    { id: 'email',         label: 'Email',               width: 16 },
    { id: 'idNumber',      label: 'ID Number',           width: 9 },
    { id: 'authorized',    label: 'Authorized Students', width: 13 },
    { id: 'faces',         label: 'Faces',               width: 5 },
    { id: 'status',        label: 'Status',              width: 7 },
    { id: 'lifecycle',     label: 'Lifecycle',           width: 7 },
    { id: 'deletedAt',     label: 'Deleted At',          width: 12 },
    { id: 'deletedReason', label: 'Deleted Reason',      width: 18 },
    { id: 'enrolled',      label: 'Enrolled',            width: 5 },
    { id: 'added',         label: 'Added',               width: 7 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_compliance', rateLimit: 30 });
