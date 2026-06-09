import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';

const { renderDownload, buildPreview } = require('../../../lib/downloads-helpers');
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

async function buildRows(db, tid) {
  const [classSnap, studentSnap] = await Promise.all([
    db.collection(tenancy.pickupClassesPath(tid)).get().catch(() => null),
    db.collection(tenancy.studentsPath(tid)).limit(2000).get().catch(() => null),
  ]);

  const rows = new Map();
  if (classSnap) {
    classSnap.forEach((doc) => {
      const data = doc.data() || {};
      const key = normalizeClassKey(doc.id);
      rows.set(key, {
        label: String(data.label || doc.id).trim() || doc.id,
        level: String(data.level || deriveLevel(key)).trim().toUpperCase(),
        active: data.active !== false,
        notes: String(data.notes || '').trim(),
        studentCount: 0,
        faceReady: 0,
        deviceReady: 0,
        missingParentPhone: 0,
      });
    });
  }

  if (studentSnap) {
    studentSnap.forEach((doc) => {
      const data = doc.data() || {};
      const key = normalizeClassKey(data.homeroom || data.class || data.className || '');
      if (!key) return;
      const row = rows.get(key) || {
        label: key,
        level: deriveLevel(key),
        active: true,
        notes: '',
        studentCount: 0,
        faceReady: 0,
        deviceReady: 0,
        missingParentPhone: 0,
      };
      row.studentCount += 1;
      const faceCount = Array.isArray(data.facePaths)
        ? data.facePaths.length
        : Array.isArray(data.photoUrls)
          ? data.photoUrls.length
          : 0;
      if (faceCount > 0) row.faceReady += 1;
      if (data.deviceEnrolled === true) row.deviceReady += 1;
      if (!(data.parentPhone || data.guardianPhone)) row.missingParentPhone += 1;
      rows.set(key, row);
    });
  }

  return Array.from(rows.values()).sort((left, right) => {
    const levelCmp = String(left.level || '').localeCompare(String(right.level || ''), undefined, { numeric: true });
    if (levelCmp !== 0) return levelCmp;
    return String(left.label || '').localeCompare(String(right.label || ''), undefined, { numeric: true });
  });
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
  const entries = await buildRows(db, tid);
  const rows = entries.map((item) => [
    item.label,
    item.level || '—',
    item.active ? 'ACTIVE' : 'ARCHIVED',
    item.studentCount,
    item.faceReady,
    item.deviceReady,
    item.missingParentPhone,
    item.notes || '',
  ]);

  const payload = {
    format: fmt,
    kind: 'class-directory',
    dateStamp: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    title: 'Class Directory',
    subtitle: 'Managed class list with student readiness counts',
    theme: 'navy',
    range: `Snapshot · ${new Date().toISOString().slice(0, 10)}`,
    actor: req.user?.email || '—',
    tenant: tid,
    kpis: [
      ['Classes', entries.length.toLocaleString()],
      ['Students', entries.reduce((sum, item) => sum + item.studentCount, 0).toLocaleString()],
      ['Face-ready', entries.reduce((sum, item) => sum + item.faceReady, 0).toLocaleString()],
      ['Archived classes', entries.filter((item) => !item.active).length.toLocaleString()],
    ],
    columns: ['Class', 'Level', 'Status', 'Students', 'Face Ready', 'Device Ready', 'Missing Parent Phone', 'Notes'],
    colWidths: [10, 8, 9, 8, 10, 11, 18, 22],
    rows,
    truncated: false,
    sheetName: 'Classes',
    notes: [],
  };

  if (req.body?.preview === true) return res.status(200).json(buildPreview(payload));

  const reauth = await verifyReauth(req, { maxAgeSec: 300 });
  if (!reauth.ok) {
    try {
      await logAudit(db, {
        tenantId: tid,
        actor: req.user || null,
        kind: 'downloads.class_directory.reauth_failed',
        target: { type: 'report', id: 'class-directory' },
        summary: `Re-auth failed for class directory download: ${reauth.error}`,
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
      kind: 'downloads.class_directory.export',
      target: { type: 'report', id: 'class-directory', label: out.filename },
      summary: `Downloaded class directory (${fmt.toUpperCase()})`,
      metadata: { format: fmt, rows: rows.length, reauthAuthTime: reauth.authTime },
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