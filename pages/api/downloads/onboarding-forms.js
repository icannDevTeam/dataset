/**
 * POST /api/downloads/onboarding-forms
 *
 * Tabular roster of parent onboarding submissions (one row per form).
 * Intentionally a roster — not the deep per-submission PDF rendered by
 * `/api/pickup/admin/onboarding-export`. Use that endpoint when you need
 * the full form contents; use this one for compliance / audit summaries.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { renderDownload, validateExportRequest, buildPreview, MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { logAudit } = require('../../../lib/audit-log');
const { verifyReauth } = require('../../../lib/reauth');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

function toIso(v) {
  if (!v) return '';
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toISOString();
  return '';
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const v = validateExportRequest(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error, message: v.message });
  const { from, to, format: fmt } = v;
  const filters = req.body?.filters || {};
  const statusFilter = filters.status ? String(filters.status).toLowerCase() : null;

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();

  // Range is inclusive of `to`; the collection stores `createdAt` as a
  // Firestore Timestamp. We over-fetch and filter client-side because the
  // collection is small enough (< MAX_ROWS) and avoids needing a composite
  // index on (status, createdAt).
  const fromMs = new Date(`${from}T00:00:00.000Z`).getTime();
  const toMs   = new Date(`${to}T23:59:59.999Z`).getTime();

  const snap = await db.collection(tenancy.pickupOnboardingPath(tid))
    .orderBy('createdAt', 'desc')
    .limit(MAX_ROWS + 1)
    .get()
    .catch(() => null);

  const rows = [];
  let approved = 0, pending = 0, rejected = 0;
  let chaperoneTotal = 0;
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
      if (status === 'approved') approved++;
      else if (status === 'rejected' || status === 'denied') rejected++;
      else pending++;
      const chaps = Array.isArray(s.chaperones) ? s.chaperones : [];
      const studs = Array.isArray(s.students) ? s.students : [];
      chaperoneTotal += chaps.length;
      rows.push([
        d.id,
        createdIso ? createdIso.slice(0, 10) : '—',
        s.parentName || s.submitterName || '—',
        s.parentEmail || s.email || '',
        s.parentPhone || s.phone || '',
        studs.map((x) => x.name || x.binusId || '').filter(Boolean).join(', '),
        chaps.map((c) => c.name || '').filter(Boolean).join(', '),
        status,
        s.reviewedBy || '',
        toIso(s.reviewedAt).slice(0, 10),
      ]);
    });
  }

  const payload = {
    format: fmt,
    kind: 'onboarding-forms',
    dateStamp: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    title: 'Onboarding Forms',
    subtitle: 'Parent-submitted pickup onboarding forms',
    theme: 'green',
    range: `${from} → ${to}`,
    actor: req.user?.email || '—',
    tenant: tid,
    kpis: [
      ['Submissions',      rows.length.toLocaleString()],
      ['Approved',         approved.toLocaleString()],
      ['Pending review',   pending.toLocaleString()],
      ['Rejected',         rejected.toLocaleString()],
      ['Chaperones total', chaperoneTotal.toLocaleString()],
      ['Avg per form',     rows.length ? (chaperoneTotal / rows.length).toFixed(1) : '0'],
    ],
    columns: ['Submission ID', 'Submitted', 'Parent', 'Email', 'Phone', 'Students', 'Chaperones', 'Status', 'Reviewed By', 'Reviewed'],
    colWidths: [12, 10, 16, 18, 13, 18, 18, 9, 14, 10],
    rows,
    truncated,
    sheetName: 'Onboarding',
    notes: statusFilter ? [`Filtered by status: ${statusFilter}`] : [],
  };

  if (req.body && req.body.preview === true) {
    return res.status(200).json(buildPreview(payload));
  }

  const reauth = await verifyReauth(req, { maxAgeSec: 300 });
  if (!reauth.ok) {
    try {
      await logAudit(db, {
        tenantId: tid, actor: req.user || null,
        kind: 'downloads.onboarding_forms.reauth_failed',
        target: { type: 'report', id: 'onboarding-forms' },
        summary: `Re-auth failed for onboarding forms download: ${reauth.error}`,
        metadata: { error: reauth.error, format: fmt, range: `${from}..${to}` },
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
      kind: 'downloads.onboarding_forms.export',
      target: { type: 'report', id: 'onboarding-forms', label: out.filename },
      summary: `Downloaded onboarding forms (${fmt.toUpperCase()})`,
      metadata: { format: fmt, rows: rows.length, range: `${from}..${to}`, statusFilter, truncated, reauthAuthTime: reauth.authTime },
      req,
    });
  } catch {}

  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
}

export default withApi(handler, { methods: ['POST'], permission: 'downloads.download_operational', rateLimit: 30 });
