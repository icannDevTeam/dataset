/**
 * POST /api/downloads/chaperone-roster
 * Full chaperone directory from `tenants/{tid}/chaperones`.
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
  // No date range needed for chaperone roster (full list) — but validate format.
  const fmt = String(req.body?.format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf', 'csv'].includes(fmt)) {
    return res.status(400).json({ error: 'bad_format', message: "format must be 'xlsx', 'pdf' or 'csv'" });
  }

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();

  const snap = await db.collection(tenancy.chaperonesPath(tid))
    .orderBy('createdAt', 'desc')
    .limit(MAX_ROWS + 1)
    .get()
    .catch(() => null);

  const rows = [];
  let active = 0, suspended = 0, withFaces = 0, deletedCount = 0;
  let truncated = false;

  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const c = d.data() || {};
      const status = c.status || (c.suspended ? 'suspended' : 'active');
      if (status === 'suspended') suspended++; else active++;
      const faceCount = (c.facePaths || c.photoUrls || []).length;
      if (faceCount > 0) withFaces++;
      const lifecycle = c.lifecycleStatus || 'active';
      if (lifecycle === 'deleted') deletedCount++;
      const deletedAtIso = c.deletedAt?.toDate ? c.deletedAt.toDate().toISOString()
        : (typeof c.deletedAt === 'string' ? c.deletedAt : '');

      const createdIso = c.createdAt?.toDate ? c.createdAt.toDate().toISOString()
        : (typeof c.createdAt === 'string' ? c.createdAt : '');

      rows.push([
        c.name || '—',
        c.relation || c.relationship || '',
        c.phone || '',
        c.email || '',
        c.idNumber || '',
        (c.authorizedStudentIds || []).join(', '),
        faceCount,
        status,
        lifecycle,
        deletedAtIso ? deletedAtIso.slice(0, 19).replace('T', ' ') : '',
        c.deletedReason || '',
        c.deviceEnrolled ? 'YES' : '',
        createdIso ? createdIso.slice(0, 10) : '',
      ]);
    });
  }

  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const payload = {
    format: fmt,
    kind: 'chaperone-roster',
    dateStamp,
    title: 'Chaperone Roster',
    subtitle: 'All registered pickup chaperones / guardians',
    theme: 'green',
    range: `Snapshot · ${new Date().toISOString().slice(0, 10)}`,
    actor: req.user?.email || '—',
    tenant: tid,
    kpis: [
      ['Total chaperones',    rows.length.toLocaleString()],
      ['Active',              active.toLocaleString()],
      ['Suspended',           suspended.toLocaleString()],
      ['Shadow-deleted',      deletedCount.toLocaleString()],
      ['Face-enrolled',       withFaces.toLocaleString()],
      ['Enrollment rate',     rows.length ? `${((withFaces / rows.length) * 100).toFixed(1)}%` : '—'],
      ['As of',               new Date().toISOString().slice(0, 10)],
    ],
    columns: ['Name', 'Relation', 'Phone', 'Email', 'ID Number', 'Authorized Students', 'Faces', 'Status', 'Lifecycle', 'Deleted At', 'Deleted Reason', 'Enrolled', 'Added'],
    colWidths: [14, 7, 11, 16, 9, 13, 5, 7, 7, 12, 18, 5, 7],
    rows,
    truncated,
    sheetName: 'Chaperones',
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
        kind: 'downloads.chaperone_roster.reauth_failed',
        target: { type: 'report', id: 'chaperone-roster' },
        summary: `Re-auth failed for chaperone roster download: ${reauth.error}`,
        metadata: { error: reauth.error, format: fmt },
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
      kind: 'downloads.chaperone_roster.export',
      target: { type: 'report', id: 'chaperone-roster', label: out.filename },
      summary: `Downloaded chaperone roster (${fmt.toUpperCase()})`,
      metadata: { format: fmt, rows: rows.length, truncated, reauthAuthTime: reauth.authTime },
      req,
    });
  } catch {}

  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
}

export default withApi(handler, { methods: ['POST'], permission: 'downloads.download_operational', rateLimit: 30 });
