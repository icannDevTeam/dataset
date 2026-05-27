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
const { renderDownload, validateExportRequest, buildPreview, MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { logAudit } = require('../../../lib/audit-log');
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

  // Pull all chaperones (admin-only collection), then walk revisions per
  // doc. Two-step because Firestore lacks a cross-collection-group query
  // we can guarantee an index for without adding one.
  const chapSnap = await db.collection(tenancy.chaperonesPath(tid))
    .limit(MAX_ROWS + 1)
    .get()
    .catch(() => null);

  const rows = [];
  const actionCount = { create: 0, update: 0, delete: 0, restore: 0 };
  const actorSet = new Set();
  const chaperoneSet = new Set();
  let truncated = false;

  if (chapSnap) {
    for (const cDoc of chapSnap.docs) {
      if (rows.length >= MAX_ROWS) { truncated = true; break; }
      const chap = cDoc.data() || {};
      const chapName = chap.name || cDoc.id;
      const revSnap = await db.collection(`${tenancy.chaperonesPath(tid)}/${cDoc.id}/revisions`)
        .orderBy('at', 'desc')
        .limit(500)
        .get()
        .catch(() => null);
      if (!revSnap) continue;
      revSnap.forEach((rDoc) => {
        if (rows.length >= MAX_ROWS) { truncated = true; return; }
        const r = rDoc.data() || {};
        const ts = r.at ? Date.parse(r.at) : NaN;
        if (Number.isNaN(ts) || ts < fromMs || ts > toMs) return;
        const action = r.action || '—';
        if (actionCount[action] != null) actionCount[action]++;
        const byEmail = r.by?.email || r.by?.uid || '—';
        actorSet.add(byEmail);
        chaperoneSet.add(cDoc.id);
        rows.push([
          (r.at || '').slice(0, 19).replace('T', ' '),
          action,
          cDoc.id,
          chapName,
          chap.employeeNo || '',
          byEmail,
          r.by?.role || '',
          (r.reason || '').slice(0, 200),
        ]);
      });
    }
  }

  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const payload = {
    format: v.format,
    kind: 'chaperone-audit',
    dateStamp,
    title: 'Chaperone Audit Trail',
    subtitle: 'Shadow-delete / restore / mutation revisions per chaperone',
    theme: 'orange',
    range: `${v.from} → ${v.to} (${v.days} days)`,
    actor: req.user?.email || '—',
    tenant: tid,
    kpis: [
      ['Total revisions',  rows.length.toLocaleString()],
      ['Chaperones affected', chaperoneSet.size.toLocaleString()],
      ['Unique actors',    actorSet.size.toLocaleString()],
      ['Deletes',          actionCount.delete.toLocaleString()],
      ['Restores',         actionCount.restore.toLocaleString()],
      ['Days covered',     v.days],
    ],
    columns: ['When', 'Action', 'Chaperone ID', 'Name', 'EmployeeNo', 'By', 'Role', 'Reason'],
    colWidths: [13, 9, 12, 18, 9, 17, 7, 15],
    rows,
    truncated,
    sheetName: 'Chaperone Audit',
    notes: [],
  };

  if (req.body && req.body.preview === true) {
    return res.status(200).json(buildPreview(payload));
  }

  const reauth = await verifyReauth(req, { maxAgeSec: 300 });
  if (!reauth.ok) {
    try {
      await logAudit(db, {
        tenantId: tid, actor: req.user || null,
        kind: 'downloads.chaperone_audit.reauth_failed',
        target: { type: 'report', id: 'chaperone-audit' },
        summary: `Re-auth failed for chaperone audit download: ${reauth.error}`,
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
      kind: 'downloads.chaperone_audit.export',
      target: { type: 'report', id: 'chaperone-audit', label: out.filename },
      summary: `Downloaded chaperone audit trail (${v.format.toUpperCase()})`,
      metadata: { format: v.format, from: v.from, to: v.to, rows: rows.length, truncated, reauthAuthTime: reauth.authTime },
      req,
    });
  } catch {}

  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
}

export default withApi(handler, { methods: ['POST'], permission: 'downloads.download_operational', rateLimit: 30 });
