/**
 * POST /api/downloads/onboarding-forms
 *
 * Tabular roster of parent onboarding submissions (one row per form).
 * Intentionally a roster — not the deep per-submission PDF rendered by
 * `/api/pickup/admin/onboarding-export`. Use that endpoint when you need
 * the full form contents; use this one for compliance / audit summaries.
 *
 * Permission moved from `download_operational` to `download_directory`
 * (M1 — directory data sits in its own bucket so the pickup-admin role
 * can have operational without also pulling parent contact info).
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { runDownload } = require('../../../lib/download-runner');
const { MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

function toIso(v) {
  if (!v) return '';
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return '';
}

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = ctx.tenantId || tenancy.getTenantId();
  const fromMs = new Date(`${ctx.from}T00:00:00.000Z`).getTime();
  const toMs   = new Date(`${ctx.to}T23:59:59.999Z`).getTime();
  const statusFilter = ctx.filters?.status ? String(ctx.filters.status).toLowerCase() : null;

  const snap = await db.collection(tenancy.pickupOnboardingPath(tid))
    .orderBy('createdAt', 'desc').limit(MAX_ROWS + 1).get().catch(() => null);

  const rows = [];
  let truncated = false;
  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const s = d.data() || {};
      const createdIso = toIso(s.createdAt);
      const createdMs = createdIso ? new Date(createdIso).getTime() : 0;
      if (createdMs && (createdMs < fromMs || createdMs > toMs)) return;
      const status = String(s.status || s.state || 'pending').toLowerCase();
      if (statusFilter && status !== statusFilter) return;
      const chaps = Array.isArray(s.chaperones) ? s.chaperones : [];
      const studs = Array.isArray(s.students) ? s.students : [];
      rows.push({
        submissionId: d.id,
        submitted:    createdIso ? createdIso.slice(0, 10) : '\u2014',
        parent:       s.parentName || s.submitterName || '\u2014',
        email:        s.parentEmail || s.email || '',
        phone:        s.parentPhone || s.phone || '',
        students:     studs.map((x) => x.name || x.binusId || '').filter(Boolean).join(', '),
        chaperones:   chaps.map((c) => c.name || '').filter(Boolean).join(', '),
        status,
        reviewedBy:   s.reviewedBy || '',
        reviewed:     toIso(s.reviewedAt).slice(0, 10),
        _chapCount:   chaps.length,
      });
    });
  }
  return { rows, meta: { truncated, notes: statusFilter ? [`Filtered by status: ${statusFilter}`] : [] } };
}

function kpis(rows) {
  let approved = 0, pending = 0, rejected = 0, chaperoneTotal = 0;
  for (const r of rows) {
    if (r.status === 'approved') approved++;
    else if (r.status === 'rejected' || r.status === 'denied') rejected++;
    else pending++;
    chaperoneTotal += r._chapCount || 0;
  }
  return [
    ['Submissions',      rows.length.toLocaleString()],
    ['Approved',         approved.toLocaleString()],
    ['Pending review',   pending.toLocaleString()],
    ['Rejected',         rejected.toLocaleString()],
    ['Chaperones total', chaperoneTotal.toLocaleString()],
    ['Avg per form',     rows.length ? (chaperoneTotal / rows.length).toFixed(1) : '0'],
  ];
}

export default withApi(runDownload({
  cardId: 'onboarding-forms',
  title: 'Onboarding Forms',
  subtitle: 'Parent-submitted pickup onboarding forms',
  theme: 'green',
  sheetName: 'Onboarding',
  maxDays: 365,
  columns: [
    { id: 'submissionId', label: 'Submission ID', width: 12 },
    { id: 'submitted',    label: 'Submitted',     width: 10 },
    { id: 'parent',       label: 'Parent',        width: 16 },
    { id: 'email',        label: 'Email',         width: 18 },
    { id: 'phone',        label: 'Phone',         width: 13 },
    { id: 'students',     label: 'Students',      width: 18 },
    { id: 'chaperones',   label: 'Chaperones',    width: 18 },
    { id: 'status',       label: 'Status',        width: 9 },
    { id: 'reviewedBy',   label: 'Reviewed By',   width: 14 },
    { id: 'reviewed',     label: 'Reviewed',      width: 10 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_directory', rateLimit: 30 });
