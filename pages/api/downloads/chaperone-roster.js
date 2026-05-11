/**
 * POST /api/downloads/chaperone-roster
 * Full chaperone directory from `tenants/{tid}/chaperones`.
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
  let active = 0, suspended = 0, withFaces = 0;
  let truncated = false;

  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const c = d.data() || {};
      const status = c.status || (c.suspended ? 'suspended' : 'active');
      if (status === 'suspended') suspended++; else active++;
      const faceCount = (c.facePaths || c.photoUrls || []).length;
      if (faceCount > 0) withFaces++;

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
        c.deviceEnrolled ? 'YES' : '',
        createdIso ? createdIso.slice(0, 10) : '',
      ]);
    });
  }

  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const out = await renderDownload({
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
      ['Face-enrolled',       withFaces.toLocaleString()],
      ['Enrollment rate',     rows.length ? `${((withFaces / rows.length) * 100).toFixed(1)}%` : '—'],
      ['As of',               new Date().toISOString().slice(0, 10)],
    ],
    columns: ['Name', 'Relation', 'Phone', 'Email', 'ID Number', 'Authorized Students', 'Faces', 'Status', 'Enrolled', 'Added'],
    colWidths: [16, 8, 12, 18, 11, 16, 6, 8, 7, 9],
    rows,
    truncated,
    sheetName: 'Chaperones',
    notes: [],
  });

  try {
    await logAudit(db, {
      tenantId: tid,
      actor: req.user || null,
      kind: 'downloads.chaperone_roster.export',
      target: { type: 'report', id: 'chaperone-roster', label: out.filename },
      summary: `Downloaded chaperone roster (${fmt.toUpperCase()})`,
      metadata: { format: fmt, rows: rows.length, truncated },
      req,
    });
  } catch {}

  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
}

export default withApi(handler, { methods: ['POST'], permission: 'downloads.download_operational' });
