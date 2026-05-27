/**
 * POST /api/downloads/audit-log
 * Standalone export of `tenants/{tid}/audit_log` for compliance use.
 * Permission moved from `download_audit` (removed) to `download_compliance`.
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
  const kindFilter = ctx.filters?.kind ? String(ctx.filters.kind).trim() : null;

  const snap = await db.collection(auditLogPath(tid)).orderBy('at', 'desc').limit(MAX_ROWS + 1).get().catch(() => null);
  const rows = [];
  let truncated = false;
  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const e = d.data() || {};
      const ts = e.at ? Date.parse(e.at) : NaN;
      if (Number.isNaN(ts) || ts < fromMs || ts > toMs) return;
      const kind = e.kind || '\u2014';
      if (kindFilter && !kind.startsWith(kindFilter)) return;
      rows.push({
        when:    (e.at || '').slice(0, 19).replace('T', ' '),
        kind,
        actor:   e.actor?.email || e.actor?.name || '\u2014',
        target:  e.target?.label || e.target?.id || '',
        summary: e.summary || '',
        ip:      e.ip || '',
      });
    });
  }
  return { rows, meta: { truncated, notes: kindFilter ? [`Filtered by kind prefix: ${kindFilter}`] : [] } };
}

function kpis(rows, ctx) {
  const actorSet = new Set(); const kindCount = {};
  for (const r of rows) { actorSet.add(r.actor); kindCount[r.kind] = (kindCount[r.kind] || 0) + 1; }
  const topKinds = Object.entries(kindCount).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, c]) => `${k} (${c})`).join(', ') || '\u2014';
  return [
    ['Total entries',  rows.length.toLocaleString()],
    ['Unique actors',  actorSet.size.toLocaleString()],
    ['Distinct kinds', Object.keys(kindCount).length.toLocaleString()],
    ['Top kinds',      topKinds],
    ['Days covered',   ctx.days],
    ['Avg per day',    ctx.days ? Math.round(rows.length / ctx.days) : 0],
  ];
}

export default withApi(runDownload({
  cardId: 'audit-log',
  title: 'System Audit Log',
  subtitle: 'Every mutating action across the system',
  theme: 'teal',
  sheetName: 'Audit Log',
  maxDays: 365,
  columns: [
    { id: 'when',    label: 'When',    width: 13 },
    { id: 'kind',    label: 'Kind',    width: 16 },
    { id: 'actor',   label: 'Actor',   width: 17 },
    { id: 'target',  label: 'Target',  width: 18 },
    { id: 'summary', label: 'Summary', width: 26 },
    { id: 'ip',      label: 'IP',      width: 10 },
  ],
  fetcher,
  kpis,
}), { methods: ['POST'], permission: 'downloads.download_compliance', rateLimit: 30 });
