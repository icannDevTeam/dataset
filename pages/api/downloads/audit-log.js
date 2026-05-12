/**
 * POST /api/downloads/audit-log
 * Standalone export of `tenants/{tid}/audit_log` for compliance use.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { renderDownload, validateExportRequest, buildPreview, MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { auditLogPath, logAudit } = require('../../../lib/audit-log');
const { verifyReauth } = require('../../../lib/reauth');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const v = validateExportRequest(req.body || {}, { maxDays: 365 });
  if (v.error) return res.status(v.error.status).json(v.error.body);

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();

  const fromMs = new Date(v.from + 'T00:00:00+07:00').getTime();
  const toMs   = new Date(v.to   + 'T23:59:59+07:00').getTime();

  const filters = (req.body && req.body.filters) || {};
  const kindFilter = filters.kind ? String(filters.kind).trim() : null;

  const snap = await db.collection(auditLogPath(tid))
    .orderBy('at', 'desc')
    .limit(MAX_ROWS + 1)
    .get()
    .catch(() => null);

  const rows = [];
  const actorSet = new Set();
  const kindCount = {};
  let truncated = false;

  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const e = d.data() || {};
      const ts = e.at ? Date.parse(e.at) : NaN;
      if (Number.isNaN(ts) || ts < fromMs || ts > toMs) return;
      const kind = e.kind || '—';
      if (kindFilter && !kind.startsWith(kindFilter)) return;
      kindCount[kind] = (kindCount[kind] || 0) + 1;
      const actor = e.actor?.email || e.actor?.name || '—';
      actorSet.add(actor);
      rows.push([
        (e.at || '').slice(0, 19).replace('T', ' '),
        kind,
        actor,
        e.target?.label || e.target?.id || '',
        e.summary || '',
        e.ip || '',
      ]);
    });
  }

  const topKinds = Object.entries(kindCount).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, c]) => `${k} (${c})`).join(', ') || '—';

  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const payload = {
    format: v.format,
    kind: 'audit-log',
    dateStamp,
    title: 'System Audit Log',
    subtitle: 'Every mutating action across the system',
    theme: 'teal',
    range: `${v.from} → ${v.to} (${v.days} days)`,
    actor: req.user?.email || '—',
    tenant: tid,
    kpis: [
      ['Total entries',    rows.length.toLocaleString()],
      ['Unique actors',    actorSet.size.toLocaleString()],
      ['Distinct kinds',   Object.keys(kindCount).length.toLocaleString()],
      ['Top kinds',        topKinds],
      ['Days covered',     v.days],
      ['Avg per day',      v.days ? Math.round(rows.length / v.days) : 0],
    ],
    columns: ['When', 'Kind', 'Actor', 'Target', 'Summary', 'IP'],
    colWidths: [13, 16, 17, 18, 26, 10],
    rows,
    truncated,
    sheetName: 'Audit Log',
    notes: kindFilter ? [`Filtered by kind prefix: ${kindFilter}`] : [],
  };

  if (req.body && req.body.preview === true) {
    return res.status(200).json(buildPreview(payload));
  }

  const reauth = await verifyReauth(req, { maxAgeSec: 300 });
  if (!reauth.ok) {
    try {
      await logAudit(db, {
        tenantId: tid, actor: req.user || null,
        kind: 'downloads.audit_log.reauth_failed',
        target: { type: 'report', id: 'audit-log' },
        summary: `Re-auth failed for audit log download: ${reauth.error}`,
        metadata: { error: reauth.error, format: v.format, from: v.from, to: v.to },
        req,
      });
    } catch {}
    if (reauth.retryAfterSec) res.setHeader('Retry-After', reauth.retryAfterSec);
    return res.status(reauth.status).json({ error: reauth.error, message: reauth.message, retryAfter: reauth.retryAfterSec });
  }

  const out = await renderDownload(payload);

  try {
    await logAudit(db, {
      tenantId: tid,
      actor: req.user || null,
      kind: 'downloads.audit_log.export',
      target: { type: 'report', id: 'audit-log', label: out.filename },
      summary: `Downloaded audit log (${v.format.toUpperCase()})`,
      metadata: { format: v.format, from: v.from, to: v.to, rows: rows.length, truncated, kindFilter, reauthAuthTime: reauth.authTime },
      req,
    });
  } catch {}

  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
}

export default withApi(handler, { methods: ['POST'], permission: 'downloads.download_audit', rateLimit: 30 });
