/**
 * POST /api/downloads/audit-export
 *
 * Compliance-oriented export of `tenants/{tid}/audit_log` across a date
 * range, with optional substring filter on `actionKind`. Distinct from
 * the legacy `audit-log` card — this one carries richer columns
 * (actor.role, target.type, target.id, target.label) for auditors.
 *
 * Body: { format, from, to, filters?: { actionKind }, preview?, dryRun? }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { runDownload } = require('../../../lib/download-runner');
const { MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { auditLogPath } = require('../../../lib/audit-log');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

async function fetcher(ctx) {
  initializeFirebase();
  const db = admin.firestore();
  const tid = ctx.tenantId || tenancy.getTenantId();
  const fromMs = new Date(ctx.from + 'T00:00:00+07:00').getTime();
  const toMs   = new Date(ctx.to   + 'T23:59:59+07:00').getTime();
  const kindFilter = ctx.filters?.actionKind ? String(ctx.filters.actionKind).trim().toLowerCase() : null;

  const snap = await db.collection(auditLogPath(tid))
    .orderBy('at', 'desc').limit(MAX_ROWS + 1).get().catch(() => null);

  const rows = [];
  let truncated = false;
  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const e = d.data() || {};
      const ts = e.at ? Date.parse(e.at) : NaN;
      if (Number.isNaN(ts) || ts < fromMs || ts > toMs) return;
      const kind = e.kind || '\u2014';
      if (kindFilter && !String(kind).toLowerCase().includes(kindFilter)) return;
      rows.push({
        at:           (e.at || '').slice(0, 19).replace('T', ' '),
        actorEmail:   e.actor?.email || '',
        actorRole:    e.actor?.role  || '',
        kind,
        targetType:   e.target?.type  || '',
        targetId:     e.target?.id    || '',
        targetLabel:  e.target?.label || '',
        summary:      e.summary || '',
        ip:           e.ip || '',
      });
    });
  }
  return { rows, meta: { truncated, notes: kindFilter ? [`Filtered by actionKind substring: ${kindFilter}`] : [] } };
}

function kpis(rows, ctx) {
  const actors = new Set();
  const kinds  = new Set();
  for (const r of rows) {
    if (r.actorEmail) actors.add(r.actorEmail);
    if (r.kind)       kinds.add(r.kind);
  }
  return [
    ['Total events',     rows.length.toLocaleString()],
    ['Distinct actors',  actors.size.toLocaleString()],
    ['Distinct kinds',   kinds.size.toLocaleString()],
    ['Days covered',     ctx.days],
    ['Avg per day',      ctx.days ? Math.round(rows.length / ctx.days) : 0],
  ];
}

export default withApi(runDownload({
  cardId: 'audit-export',
  title: 'Audit Log Export',
  subtitle: 'Compliance export of every mutating action across the system',
  theme: 'indigo',
  sheetName: 'Audit',
  maxDays: 365,
  needsRange: true,
  columns: [
    { id: 'at',          label: 'When',         width: 13 },
    { id: 'actorEmail',  label: 'Actor Email',  width: 16 },
    { id: 'actorRole',   label: 'Role',         width: 8  },
    { id: 'kind',        label: 'Kind',         width: 14 },
    { id: 'targetType',  label: 'Target Type',  width: 10 },
    { id: 'targetId',    label: 'Target ID',    width: 12 },
    { id: 'targetLabel', label: 'Target Label', width: 14 },
    { id: 'summary',     label: 'Summary',      width: 22 },
    { id: 'ip',          label: 'IP',           width: 10 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_compliance', rateLimit: 30 });
