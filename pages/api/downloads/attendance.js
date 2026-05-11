/**
 * POST /api/downloads/attendance
 *
 * Branded export of facial-attendance scans across a date range.
 * Pulls from root `attendance/{YYYY-MM-DD}/records/*` (legacy schema).
 *
 * Body: { format, from, to, filters?: { class, status } }
 */
import admin from 'firebase-admin';
import { initializeFirebase } from '../../../lib/firebase-admin';
import { withApi } from '../../../lib/api-auth';
const { renderDownload, validateExportRequest, buildPreview, MAX_ROWS } = require('../../../lib/downloads-helpers');
const tenancy = require('../../../lib/tenancy');
const { logAudit } = require('../../../lib/audit-log');

export const config = { api: { bodyParser: { sizeLimit: '128kb' }, responseLimit: false } };

function dateRange(from, to) {
  const out = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const v = validateExportRequest(req.body || {}, { maxDays: 365 });
  if (v.error) return res.status(v.error.status).json(v.error.body);

  const filters = (req.body && req.body.filters) || {};
  const filterClass = filters.class ? String(filters.class).trim() : null;
  const filterStatus = filters.status ? String(filters.status).trim() : null;

  initializeFirebase();
  const db = admin.firestore();

  // Build metadata lookup once
  const [metaSnap, studentsSnap] = await Promise.all([
    db.collection('student_metadata').get(),
    db.collection('students').get().catch(() => ({ forEach: () => {} })),
  ]);
  const metaMap = {};
  metaSnap.forEach((d) => {
    const x = d.data() || {};
    metaMap[d.id] = { homeroom: x.homeroom || '', grade: x.grade || x.gradeCode || '', name: x.name || '' };
  });
  studentsSnap.forEach((d) => {
    const x = d.data() || {};
    if (!metaMap[d.id]) metaMap[d.id] = { homeroom: x.homeroom || '', grade: x.gradeCode || x.grade || '', name: x.name || '' };
  });

  const days = dateRange(v.from, v.to);
  const rows = [];
  let totalScans = 0, onTime = 0, late = 0;
  const studentSet = new Set();
  let truncated = false;

  for (const date of days) {
    if (rows.length >= MAX_ROWS) { truncated = true; break; }
    const snap = await db.collection('attendance').doc(date).collection('records').get().catch(() => null);
    if (!snap) continue;
    snap.forEach((doc) => {
      if (rows.length >= MAX_ROWS) { truncated = true; return; }
      const r = doc.data() || {};
      const empNo = r.employeeNo || r.studentId || '';
      const meta = metaMap[empNo] || {};
      const homeroom = r.homeroom || meta.homeroom || '';
      const grade = r.grade || meta.grade || '';
      const status = r.status || (r.late ? 'Late' : 'Present');
      if (filterClass && homeroom !== filterClass) return;
      if (filterStatus && status !== filterStatus) return;
      const ts = (r.timestamp || '').slice(0, 19).replace('T', ' ');
      rows.push([
        date,
        ts || '—',
        r.name || meta.name || '—',
        empNo || '—',
        homeroom || '—',
        grade || '—',
        status,
        r.source || r.terminal || '—',
        r.confidence != null ? Number(r.confidence).toFixed(2) : '',
      ]);
      totalScans++;
      if (status === 'Late') late++; else onTime++;
      studentSet.add(empNo || r.name || Math.random());
    });
  }

  const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : '—';
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');

  const payload = {
    format: v.format,
    kind: 'attendance',
    dateStamp,
    title: 'Attendance Report',
    subtitle: 'Facial recognition attendance scans',
    theme: 'teal',
    range: `${v.from} → ${v.to} (${v.days} days)`,
    actor: req.user?.email || '—',
    tenant: tenancy.getTenantId(),
    kpis: [
      ['Total scans',         totalScans.toLocaleString()],
      ['Unique students',     studentSet.size.toLocaleString()],
      ['On-time',             `${onTime.toLocaleString()} (${pct(onTime, totalScans)})`],
      ['Late',                `${late.toLocaleString()} (${pct(late, totalScans)})`],
      ['Days covered',        v.days],
      ['Avg scans / day',     v.days ? Math.round(totalScans / v.days) : 0],
    ],
    columns: ['Date', 'Time', 'Student', 'Employee No', 'Homeroom', 'Grade', 'Status', 'Source', 'Confidence'],
    colWidths: [9, 11, 22, 10, 10, 8, 9, 12, 9],
    rows,
    truncated,
    sheetName: 'Attendance',
    notes: [
      filterClass ? `Filtered by homeroom: ${filterClass}` : null,
      filterStatus ? `Filtered by status: ${filterStatus}` : null,
    ].filter(Boolean),
  };

  if (req.body && req.body.preview === true) {
    return res.status(200).json(buildPreview(payload));
  }

  const out = await renderDownload(payload);

  try {
    await logAudit(db, {
      tenantId: tenancy.getTenantId(),
      actor: req.user || null,
      kind: 'downloads.attendance.export',
      target: { type: 'report', id: 'attendance', label: out.filename },
      summary: `Downloaded attendance report (${v.format.toUpperCase()})`,
      metadata: { format: v.format, from: v.from, to: v.to, filters, rows: rows.length, truncated },
      req,
    });
  } catch {}

  res.setHeader('Content-Type', out.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(Buffer.isBuffer(out.buf) ? out.buf : Buffer.from(out.buf));
}

export default withApi(handler, { methods: ['POST'], permission: 'downloads.download_operational' });
