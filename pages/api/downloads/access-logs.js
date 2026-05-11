/**
 * POST /api/downloads/access-logs
 * Dashboard sign-ins from root `access_logs` collection.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { renderDownload, validateExportRequest, MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { logAudit } = require('../../../lib/audit-log');

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

  // Pull from root access_logs (legacy); tenant copy is dual-written.
  const snap = await db.collection('access_logs')
    .orderBy('timestamp', 'desc')
    .limit(MAX_ROWS + 1)
    .get()
    .catch(() => null);

  const rows = [];
  const userSet = new Set();
  const ipSet = new Set();
  let truncated = false;
  let offHours = 0;

  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const r = d.data() || {};
      const tsObj = r.timestamp?.toDate ? r.timestamp.toDate() : null;
      const tsIso = tsObj ? tsObj.toISOString() : (typeof r.timestamp === 'string' ? r.timestamp : null);
      if (!tsIso) return;
      const ms = Date.parse(tsIso);
      if (Number.isNaN(ms) || ms < fromMs || ms > toMs) return;

      const wibHour = ((ms + 7 * 3600 * 1000) / 3600000) % 24 | 0;
      if (wibHour < 6 || wibHour >= 21) offHours++;

      userSet.add(r.email || '—');
      ipSet.add(r.ip || '—');

      rows.push([
        tsIso.slice(0, 19).replace('T', ' '),
        r.email || '—',
        r.name || '',
        r.ip || '—',
        r.device || '',
        r.browser || '',
        r.os || '',
        r.action || 'login',
      ]);
    });
  }

  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const out = await renderDownload({
    format: v.format,
    kind: 'access-logs',
    dateStamp,
    title: 'Dashboard Access Log',
    subtitle: 'Sign-in events across the admin console',
    theme: 'green',
    range: `${v.from} → ${v.to} (${v.days} days)`,
    actor: req.user?.email || '—',
    tenant: tid,
    kpis: [
      ['Total sign-ins',  rows.length.toLocaleString()],
      ['Unique users',    userSet.size.toLocaleString()],
      ['Unique IPs',      ipSet.size.toLocaleString()],
      ['Off-hours (9pm–6am WIB)', offHours.toLocaleString()],
      ['Days covered',    v.days],
      ['Avg per day',     v.days ? Math.round(rows.length / v.days) : 0],
    ],
    columns: ['Timestamp', 'Email', 'Name', 'IP', 'Device', 'Browser', 'OS', 'Action'],
    colWidths: [13, 18, 14, 11, 9, 11, 10, 8],
    rows,
    truncated,
    sheetName: 'Access Logs',
    notes: [
      'Off-hours threshold: any sign-in between 21:00 and 06:00 WIB.',
      'Source: root collection `access_logs` (mirrored to tenant collection).',
    ],
  });

  try {
    await logAudit(db, {
      tenantId: tid,
      actor: req.user || null,
      kind: 'downloads.access_logs.export',
      target: { type: 'report', id: 'access-logs', label: out.filename },
      summary: `Downloaded access logs (${v.format.toUpperCase()})`,
      metadata: { format: v.format, from: v.from, to: v.to, rows: rows.length, truncated },
      req,
    });
  } catch {}

  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
}

export default withApi(handler, { methods: ['POST'], permission: 'downloads.download_security' });
