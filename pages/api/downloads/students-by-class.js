import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';

const { renderDownload, buildPreview, MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { logAudit } = require('../../../lib/audit-log');
const { verifyReauth } = require('../../../lib/reauth');

function normalizeClassKey(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function deriveLevel(value) {
  const key = normalizeClassKey(value);
  if (!key) return '';
  if (/^EY\d*$/.test(key)) return 'EY';
  return key.match(/^\d+/)?.[0] || '';
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const fmt = String(req.body?.format || 'xlsx').toLowerCase();
  if (!['xlsx', 'pdf', 'csv'].includes(fmt)) {
    return res.status(400).json({ error: 'bad_format', message: "format must be 'xlsx', 'pdf' or 'csv'" });
  }

  initializeFirebase();
  const db = admin.firestore();
  const tid = tenancy.getTenantId();

  const snap = await db.collection(tenancy.studentsPath(tid)).limit(MAX_ROWS + 1).get().catch(() => null);
  const rows = [];
  const byClass = new Map();
  let truncated = false;

  if (snap) {
    snap.forEach((doc) => {
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        return;
      }
      const data = doc.data() || {};
      const homeroom = normalizeClassKey(data.homeroom || data.class || data.className || '');
      const level = String(data.grade || deriveLevel(homeroom) || '').trim().toUpperCase();
      const faces = Array.isArray(data.facePaths)
        ? data.facePaths.length
        : Array.isArray(data.photoUrls)
          ? data.photoUrls.length
          : 0;
      byClass.set(homeroom || '—', (byClass.get(homeroom || '—') || 0) + 1);
      rows.push([
        homeroom || '—',
        level || '—',
        data.binusId || data.binusianId || data.studentId || doc.id,
        data.name || data.fullName || '—',
        data.gender || '',
        faces,
        data.deviceEnrolled ? 'YES' : '',
        data.parentName || data.guardianName || '',
        data.parentPhone || data.guardianPhone || '',
      ]);
    });
  }

  rows.sort((left, right) => {
    const classCmp = String(left[0]).localeCompare(String(right[0]), undefined, { numeric: true });
    if (classCmp !== 0) return classCmp;
    return String(left[3]).localeCompare(String(right[3]));
  });

  const payload = {
    format: fmt,
    kind: 'students-by-class',
    dateStamp: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    title: 'Students By Class',
    subtitle: 'Operational roster sorted for class-by-class review',
    theme: 'navy',
    range: `Snapshot · ${new Date().toISOString().slice(0, 10)}`,
    actor: req.user?.email || '—',
    tenant: tid,
    kpis: [
      ['Students', rows.length.toLocaleString()],
      ['Classes', byClass.size.toLocaleString()],
      ...Array.from(byClass.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true })).slice(0, 4).map(([label, count]) => [label, String(count)]),
    ],
    columns: ['Class', 'Level', 'Binusian ID', 'Name', 'Gender', 'Faces', 'Enrolled', 'Parent', 'Parent Phone'],
    colWidths: [9, 8, 12, 18, 7, 6, 8, 16, 14],
    rows,
    truncated,
    sheetName: 'StudentsByClass',
    notes: [],
  };

  if (req.body?.preview === true) return res.status(200).json(buildPreview(payload));

  const reauth = await verifyReauth(req, { maxAgeSec: 300 });
  if (!reauth.ok) {
    try {
      await logAudit(db, {
        tenantId: tid,
        actor: req.user || null,
        kind: 'downloads.students_by_class.reauth_failed',
        target: { type: 'report', id: 'students-by-class' },
        summary: `Re-auth failed for students by class download: ${reauth.error}`,
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
      kind: 'downloads.students_by_class.export',
      target: { type: 'report', id: 'students-by-class', label: out.filename },
      summary: `Downloaded students by class (${fmt.toUpperCase()})`,
      metadata: { format: fmt, rows: rows.length, truncated, reauthAuthTime: reauth.authTime },
      req,
    });
  } catch {}

  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
}

export default withApi(handler, {
  methods: ['POST'],
  anyPermission: ['downloads.download_operational', 'downloads.download_directory'],
  rateLimit: 30,
});