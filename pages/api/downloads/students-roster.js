/**
 * POST /api/downloads/students-roster
 * Full student directory from `tenants/{tid}/students`.
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { renderDownload, buildPreview, MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { logAudit } = require('../../../lib/audit-log');
const { verifyReauth } = require('../../../lib/reauth');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const fmt = String(req.body?.format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf', 'csv'].includes(fmt)) {
    return res.status(400).json({ error: 'bad_format', message: "format must be 'xlsx', 'pdf' or 'csv'" });
  }

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();

  const snap = await db.collection(tenancy.studentsPath(tid))
    .limit(MAX_ROWS + 1)
    .get()
    .catch(() => null);

  const rows = [];
  const byClass = new Map();
  let enrolled = 0;
  let truncated = false;

  if (snap) {
    snap.forEach((d) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const s = d.data() || {};
      const cls = s.homeroom || s.class || s.grade || '—';
      byClass.set(cls, (byClass.get(cls) || 0) + 1);
      const faces = (s.facePaths || s.photoUrls || []).length;
      if (faces > 0) enrolled++;
      rows.push([
        s.binusId || s.binusianId || s.studentId || d.id,
        s.name || s.fullName || '—',
        cls,
        s.gender || '',
        faces,
        s.deviceEnrolled ? 'YES' : '',
        s.parentName || '',
        s.parentPhone || '',
      ]);
    });
  }

  // Sort by class then name for a usable roster.
  rows.sort((a, b) => {
    const cmp = String(a[2]).localeCompare(String(b[2]));
    return cmp !== 0 ? cmp : String(a[1]).localeCompare(String(b[1]));
  });

  const classBreakdown = Array.from(byClass.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([k, v]) => [`Class ${k}`, String(v)]);

  const payload = {
    format: fmt,
    kind: 'students-roster',
    dateStamp: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    title: 'Student Body Roster',
    subtitle: 'All registered students across every class',
    theme: 'navy',
    range: `Snapshot · ${new Date().toISOString().slice(0, 10)}`,
    actor: req.user?.email || '—',
    tenant: tid,
    kpis: [
      ['Total students',   rows.length.toLocaleString()],
      ['Classes',          byClass.size.toLocaleString()],
      ['Face-enrolled',    enrolled.toLocaleString()],
      ['Enrollment rate',  rows.length ? `${((enrolled / rows.length) * 100).toFixed(1)}%` : '—'],
      ...classBreakdown,
    ],
    columns: ['Binusian ID', 'Name', 'Class', 'Gender', 'Faces', 'Enrolled', 'Parent', 'Parent Phone'],
    colWidths: [12, 18, 7, 7, 6, 8, 16, 13],
    rows,
    truncated,
    sheetName: 'Students',
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
        kind: 'downloads.students_roster.reauth_failed',
        target: { type: 'report', id: 'students-roster' },
        summary: `Re-auth failed for students roster download: ${reauth.error}`,
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
      kind: 'downloads.students_roster.export',
      target: { type: 'report', id: 'students-roster', label: out.filename },
      summary: `Downloaded students roster (${fmt.toUpperCase()})`,
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
